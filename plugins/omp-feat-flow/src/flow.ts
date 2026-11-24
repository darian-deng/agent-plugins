import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { admitToolCall, recordToolOutcome as recordOutcome, verifySliceDone } from "./admission";
import { executeFinish, syncRun } from "./delivery-saga";
import { deliveryBlockers } from "./evidence";
import {
	createFlowRuntime,
	defaultUiFromHost,
	effectiveLinearMode,
	effectOf,
	flowCommandDescription,
	recoveryReceipt,
	type FlowCommand,
	type FlowController,
	type ModelStatus,
	type NativeHost,
	type NativeLifecycleEvent,
	type NativeToolAttempt,
	type OnboardingHostPort,
	type RecoveryProjection,
	type ToolEffect,
} from "./flow-context";
import { decideGate, executeApprove, runColdReadForCandidate } from "./gates";
import { verifyBundledMethods } from "./methods";
import { deriveRequirementProfile, preserveAmendedReviewOverrides, type AlignmentDocument } from "./profile";
import type { RunOutcome } from "./run";
import { executeStart } from "./start";
import { buildRecoveryBrief, buildStagePrompt, buildStageWidget, type GitRecoverySnapshot } from "./steering";
import { buildAlignmentReadModel, renderTechDesignHtml } from "./tech-design";
import { inspectUpdate } from "./update";
export {
	effectOf,
	flowCommandDescription,
	recoveryReceipt,
	type FlowCommand,
	type FlowController,
	type ModelStatus,
	type NativeHost,
	type NativeLifecycleEvent,
	type NativeToolAttempt,
	type OnboardingHostPort,
	type RecoveryProjection,
	type ToolEffect,
};

function fallbackAlignmentDoc(
	scope: string,
	summary: string,
	decided: Array<{ category: string; answer: string }>,
	slices: Array<{ id: string; behavior: string; test: string }>,
): AlignmentDocument {
	const findAns = (cat: string, fallback: string) => decided.find(d => d.category === cat)?.answer ?? fallback;
	return {
		tldr: summary,
		problem: findAns("goals", summary),
		goals: [findAns("goals", summary)],
		nonGoals: [findAns("non-goals", "Stay strictly within approved scope.")],
		placement: {
			summary: `Target scope: ${scope}`,
			upstreamDownstream: [],
			constraints: [findAns("business-boundary", "Follow repository conventions.")],
			nodes: [{ id: "scope", label: scope.slice(0, 20), kind: "focal" }],
			edges: [],
		},
		mechanism: {
			overview: summary,
			contracts: [],
			failureModes: [findAns("error-path", "Fail closed on invalid input.")],
			persistenceOrMigration: "No persistence or migration change unless stated in slices.",
		},
		changeSurface: [{ path: scope, action: "modify", summary }],
		decisions: [],
		risksAndAssumptions: [],
		verification: slices.map(s => s.test).join("; ") || findAns("acceptance", "Unit tests pass."),
	};
}

export function createFlow(host: NativeHost): FlowController {
	const rt = createFlowRuntime(host);

	return {
		async lifecycle(event) {
			if (!rt.isMainAgent()) {
				rt.unavailable = "subagent-context";
				await rt.checkSubagentWorkspace();
				return;
			}
			if (event.type === "session_start") {
				await rt.ensureLoaded();
			} else if (event.type === "session_clear") {
				if (!rt.live) return;
				const current = rt.live.kernel.inspect();
				const hasUnsettled = current.operations.some(op => op.status === "dispatched" || op.status === "unknown");
				if (current.readiness === "ready" && !hasUnsettled) {
					if (rt.wrapUpPersist) {
						try { await rt.wrapUpPersist; } finally { rt.wrapUpPersist = null; }
					}
					await rt.live.kernel.apply({ kind: "context.handoff", contextEpoch: rt.live.binding.contextEpoch + 1 }, rt.live.binding);
					rt.live.binding = { ...rt.live.binding, contextEpoch: rt.live.binding.contextEpoch + 1 };
					rt.pendingWrapUpMode = null;
					rt.needsRecoveryBrief = true;
					host.notify(`${rt.live.runId}: 上下文已清空，直接发消息（如「继续」）即可接续执行。`);
				}
			} else if (event.type === "session_compact") {
				if (rt.live) rt.needsRecoveryBrief = true;
			} else if (event.type === "session_switch") {
				if (event.reason === "new" && rt.live) {
					const current = rt.live.kernel.inspect();
					const hasUnsettled = current.operations.some(op => op.status === "dispatched" || op.status === "unknown");
					if (current.readiness === "ready" && !hasUnsettled) {
						if (rt.wrapUpPersist) {
							try { await rt.wrapUpPersist; } finally { rt.wrapUpPersist = null; }
						}
						await rt.live.kernel.apply({ kind: "context.handoff", contextEpoch: rt.live.binding.contextEpoch + 1 }, rt.live.binding);
						rt.live.binding = { ...rt.live.binding, contextEpoch: rt.live.binding.contextEpoch + 1 };
						rt.pendingWrapUpMode = null;
						rt.needsRecoveryBrief = true;
						return;
					}
				}
				await rt.live?.kernel.dispose({ clean: true });
				rt.live = null;
				rt.loading = null;
				rt.unavailable = null;
				await rt.ensureLoaded();
			} else if (event.type === "session_shutdown") {
				await rt.live?.kernel.dispose({ clean: true });
				rt.live = null;
				rt.loading = null;
			}
		},

		context(): RecoveryProjection {
			if (!rt.isMainAgent() || !rt.live) {
				return {
					located: false, reason: !rt.isMainAgent() ? "subagent-context" : (rt.unavailable ?? "run-loading"),
					runId: null, revision: null, phase: null, readiness: null, waitingReason: null,
					ownerStatus: null, initialTask: null, currentTask: null, approvedScopeDigest: null, issue: null, worktree: null,
					unresolvedOperations: 0, unknownOperations: 0, openBoundaries: [], planSlices: 0,
					gateToken: null, techDesignHtmlPath: null, view: null,
				};
			}
			const view = rt.live.kernel.inspect();
			return {
				located: true, reason: null, runId: view.runId, revision: view.revision, phase: view.phase, issue: view.issue,
				worktree: view.worktree, readiness: view.readiness, waitingReason: view.waitingReason, ownerStatus: view.ownerStatus,
				initialTask: view.initialTask, currentTask: view.currentTask, approvedScopeDigest: view.approvedScope?.digest ?? null,
				unresolvedOperations: view.operations.filter(operation => operation.status === "dispatched").length,
				unknownOperations: view.operations.filter(operation => operation.status === "unknown").length,
				openBoundaries: view.grilling?.open ?? [], planSlices: view.plan?.slices.length ?? 0,
				gateToken: view.gateToken, techDesignHtmlPath: view.techDesignHtmlPath, view,
			};
		},

		beforeTool(call) {
			return admitToolCall(rt, call);
		},

		recordToolOutcome(toolCallId, toolName, input, isError) {
			recordOutcome(rt, toolCallId, toolName, input, isError);
		},

		async onContextSample() {
			if (!rt.isMainAgent() || !rt.live) return { latched: false };
			const usage = host.contextUsage?.();
			if (!usage || usage.contextWindow <= 0) return { latched: false };
			const view = rt.live.kernel.inspect();
			const wrapUpPct = view.project?.config.context?.wrapUpPct ?? 60;
			if (view.contextWrapUp || rt.pendingWrapUpMode || usage.percent < wrapUpPct) return { latched: false };
			const mode = view.phase === "implementation" && view.plan?.slices.some(s => s.status !== "done")
				? "finalizing_slice"
				: "wrap_up";
			rt.pendingWrapUpMode = mode;
			rt.wrapUpPersist = rt.live.kernel.apply({ kind: "context.wrapUp", mode, atPct: usage.percent, thresholdPct: wrapUpPct }, rt.live.binding)
				.then(() => {});
			try {
				await rt.wrapUpPersist;
			} catch (error) {
				rt.pendingWrapUpMode = null;
				rt.wrapUpPersist = null;
				throw error;
			}
			return {
				latched: true,
				mode,
				advisory: mode === "finalizing_slice"
					? `Context reached ${Math.round(usage.percent)}% (>=${wrapUpPct}%): FINALIZING_SLICE latched. Finish testing & commit ONLY the active slice, then call feat_flow_request({ checkpoint }) and ask user to /clear.`
					: `Context reached ${Math.round(usage.percent)}% (>=${wrapUpPct}%): WRAP_UP latched. Call feat_flow_request({ checkpoint }) and ask user to /clear.`,
			};
		},

		async command(name, arguments_) {
			if (!rt.isMainAgent()) throw new Error("Subagents cannot invoke feat-flow slash commands.");
			if (name === "start") {
				await executeStart(rt, arguments_);
				return;
			}
			if (name === "approve") {
				await executeApprove(rt);
				return;
			}
			if (name === "sync") {
				await syncRun(rt);
				return;
			}
			if (name === "finish") {
				await executeFinish(rt);
				return;
			}
			if (name === "update") {
				const bundle = await verifyBundledMethods();
				const installed = await host.installedRelease();
				const unresolved = rt.live ? rt.live.kernel.inspect().operations.filter(operation => operation.status === "dispatched" || operation.status === "unknown").length : 0;
				const assessment = inspectUpdate({ loadedBuildId: host.buildId, installed, unresolvedEffects: unresolved });
				const overrides = rt.cachedPack?.overriddenMethods ?? [];
				host.notify(
					`Private skills bundle (${bundle.skills.length}): ${bundle.valid ? "verified" : "invalid"} @ ${bundle.ref.slice(0, 12)}`
					+ `${overrides.length > 0 ? ` (user overrides: ${overrides.join(", ")})` : " (zero overrides)"}. `
					+ `Build: ${assessment.relation} (${assessment.detail}).`,
				);
				return;
			}

			await rt.ensureLoaded();
			const view = this.context();
			if (view.located && rt.live) {
				const run = rt.live.kernel.inspect();
				const head = (() => { try { return rt.gitHead(run.worktree); } catch { return run.currentIntegrationSha; } })();
				const stale = deliveryBlockers(run.proofs, {
					worktree: run.worktree, base: run.currentIntegrationSha, head,
					candidateDigest: run.approvedScope?.digest ?? "", configDigest: run.scopePolicyDigest, inputRevision: run.inputRevision,
				});
				const installed = await host.installedRelease();
				const build = inspectUpdate({ loadedBuildId: host.buildId, installed, unresolvedEffects: 0 });
				host.notify(`baseline ${run.currentIntegrationSha.slice(0, 12)} (start ${run.startSha.slice(0, 12)}), head ${head.slice(0, 12)}, `
					+ `issue ${run.issue ?? "unbound"}, proofs ${run.proofs.length}${stale.length ? ` (${stale.length} stale)` : ""}, build ${build.relation}`);
				host.notify(`next: ${run.knowledgeCandidate ? `approve knowledge diff for ${run.knowledgeCandidate.path}`
					: !run.approvedScope ? "align & approve plan" : run.phase === "delivered" ? "done (optional retro)" : "implement slices, then finish"}`);
			}
			host.notify(view.located
				? `run ${view.runId} r${view.revision} ${view.phase} ${view.readiness}${view.waitingReason ? ` (${view.waitingReason})` : ""}, owner ${view.ownerStatus}, approved ${view.approvedScopeDigest ? "yes" : "no"}`
				: `no run: ${view.reason}`);
		},

		async request(intent, requestId): Promise<RunOutcome & { advisory?: string | null }> {
			if (!rt.isMainAgent()) throw new Error("Subagents cannot submit feat_flow_request.");
			await rt.ensureLoaded();
			if (!rt.live) throw new Error(`No run is available: ${rt.unavailable ?? "run-loading"}.`);
			if (rt.pendingCheckPersist) await rt.pendingCheckPersist;
			if (rt.wrapUpPersist) {
				try { await rt.wrapUpPersist; } finally { rt.wrapUpPersist = null; }
			}

			let normalizedIntent = intent;
			if (intent.kind === "slice.update" && intent.status === "done") {
				await verifySliceDone(rt, intent);
				if (!intent.commitSha) {
					const head = rt.gitHead(rt.live.kernel.inspect().worktree);
					normalizedIntent = { ...intent, commitSha: head };
				}
			}
			if (intent.kind === "checkpoint") {
				const currentView = rt.live.kernel.inspect();
				const dirty = (await rt.gitText(currentView.worktree, ["status", "--porcelain"]).catch(() => "")).trim().length > 0;
				const head = (() => { try { return rt.gitHead(currentView.worktree); } catch { return null; } })();
				normalizedIntent = { ...intent, gitHead: head, gitDirty: dirty };
			} else if (intent.kind === "plan.amend") {
				const currentView = rt.live.kernel.inspect();
				if (intent.profile) {
					const adjusted = preserveAmendedReviewOverrides(currentView.profile, intent.profile);
					normalizedIntent = { ...intent, profile: adjusted };
				}
			}

			const outcome = await rt.live.kernel.apply({
				kind: "request.submit",
				requestId,
				expectedRevision: rt.live.kernel.inspect().revision,
				intent: normalizedIntent,
			}, rt.live.binding);

			if ((intent.kind === "plan" || intent.kind === "plan.amend") && outcome.view.candidate) {
				const v = outcome.view;
				const isAmend = intent.kind === "plan.amend";
				const cand = isAmend && v.pendingAmendment ? v.pendingAmendment.candidate : v.candidate!;
				const activePlan = isAmend && v.pendingAmendment ? v.pendingAmendment.plan : v.plan;
				const activeProfile = isAmend && v.pendingAmendment ? v.pendingAmendment.profile : v.profile;
				const profile = activeProfile ?? deriveRequirementProfile({
					signals: {
						expectedFiles: Math.max(1, activePlan?.slices.length ?? 1),
						distinctModules: 1,
						riskFlags: [],
						externalEffects: false,
						estimatedSlices: activePlan?.slices.length ?? 1,
					},
					actualSlices: activePlan?.slices.length ?? 1,
				});
				const doc = intent.alignmentDoc ?? fallbackAlignmentDoc(
					cand.scope,
					intent.summary ?? cand.scope,
					v.grilling?.decided ?? [],
					activePlan?.slices ?? [],
				);
				const meta = {
					runId: v.runId,
					candidateRevision: cand.revision,
					baseSha: v.currentIntegrationSha,
					linearMode: effectiveLinearMode(v.project?.config),
					issue: v.issue,
					slices: activePlan?.slices ?? [],
					midCheckpointAfterSliceId: v.midCheckpointAfterSliceId,
					isAmendment: isAmend,
				};
				const readModel = buildAlignmentReadModel(doc, profile, meta);
				rt.cachedReadModels.set(cand.digest, readModel);
				const materials = join(v.commonDir, "omp-feat-flow", "runs", v.runId, "materials");
				await mkdir(materials, { recursive: true, mode: 0o700 });
				const docPath = join(materials, `alignment-${cand.digest.slice(0, 12)}.json`);
				const htmlPath = join(materials, `tech-design-${cand.digest.slice(0, 12)}.html`);
				await Bun.write(docPath, JSON.stringify({ doc, profile, meta, readModelDigest: readModel.digest }, null, 2) + "\n");
				await Bun.write(htmlPath, renderTechDesignHtml(doc, profile, meta));
				const updated = isAmend
					? await rt.live.kernel.apply({
						kind: "amendment.record",
						candidateDigest: cand.digest,
						alignmentDocPath: docPath,
						techDesignHtmlPath: htmlPath,
						readModelDigest: readModel.digest,
					}, rt.live.binding)
					: await rt.live.kernel.apply({
						kind: "techDesign.record",
						alignmentDocPath: docPath,
						techDesignHtmlPath: htmlPath,
						candidateDigest: cand.digest,
						readModelDigest: readModel.digest,
					}, rt.live.binding);

				// Auto-open tech-design.html once in interactive sessions (eliminates separate /feat-flow-design command).
				const ui = defaultUiFromHost(host);
				if (ui.hasUI && host.openExternal && !rt.openedDesignDigests.has(cand.digest)) {
					rt.openedDesignDigests.add(cand.digest);
					const opened = await host.openExternal(htmlPath).catch(() => false);
					host.notify(opened ? `已自动打开设计视图: ${htmlPath}` : `设计视图已生成: ${htmlPath}`);
				}

				// Start background cold-read strictly on Medium/Large plans (Small tier uses instant host check).
				if (profile.tier !== "small") {
					const bgPromise = runColdReadForCandidate(rt, updated.view, readModel);
					bgPromise.catch(() => {
						if (rt.backgroundColdRead?.promise === bgPromise) rt.backgroundColdRead = null;
					});
					rt.backgroundColdRead = { digest: cand.digest, promise: bgPromise };
				}
				return updated;
			}

			if (intent.kind === "slice.update" && intent.status === "done") {
				const pendingLeft = outcome.view.plan?.slices.some(s => s.status !== "done") ?? false;
				const usage = host.contextUsage?.();
				const betweenPct = outcome.view.project?.config.context?.betweenSlicePct ?? 45;
				const wrapUpPct = outcome.view.project?.config.context?.wrapUpPct ?? 60;
				if (pendingLeft && usage && usage.percent >= betweenPct && usage.percent < wrapUpPct && !outcome.view.gateToken) {
					const advisory = `上下文已达 ${Math.round(usage.percent)}% (>=${betweenPct}%)，且仍有未完成切片。建议立即调用 feat_flow_request({ checkpoint }) 保存断点，并提示用户敲 /clear 后说「继续」再进入下一切片。`;
					host.notify(advisory);
					return { ...outcome, advisory };
				}
			}
			return outcome;
		},
		async decideGate(options) {
			return decideGate(rt, options);
		},

		stagePrompt() {
			if (!rt.isMainAgent() || !rt.live) return null;
			return buildStagePrompt(rt.live.kernel.inspect(), host.contextUsage?.(), rt.cachedPack?.packDir ?? null);
		},

		async recoveryBrief(consumeTurnFlag = false) {
			if (!rt.isMainAgent() || !rt.live) return null;
			if (consumeTurnFlag && !rt.needsRecoveryBrief) return null;
			const view = rt.live.kernel.inspect();
			const head = (() => { try { return rt.gitHead(view.worktree); } catch { return view.currentIntegrationSha; } })();
			const logRaw = await rt.gitText(view.worktree, ["log", "--oneline", `${view.currentIntegrationSha}..${head}`]).catch(() => "");
			const dirtyRaw = await rt.gitText(view.worktree, ["status", "--porcelain"]).catch(() => "");
			const snap: GitRecoverySnapshot = {
				head,
				logOneline: logRaw.split(/\r?\n/).filter(Boolean),
				dirtyFiles: dirtyRaw.split(/\r?\n/).filter(Boolean),
			};
			if (consumeTurnFlag) rt.needsRecoveryBrief = false;
			return buildRecoveryBrief(view, snap, rt.cachedPack?.packDir ?? null);
		},

		stageWidget() {
			if (!rt.isMainAgent() || !rt.live) return null;
			return buildStageWidget(rt.live.kernel.inspect(), host.contextUsage?.());
		},

		userConfig() {
			return rt.cachedUserConfig;
		},

		packDir() {
			return rt.cachedPack?.packDir ?? null;
		},

		async rebindSession() {
			await rt.loading;
			await rt.live?.kernel.dispose({ clean: true });
			rt.live = null;
			rt.loading = null;
			rt.unavailable = null;
		},

		async dispose(options) {
			rt.disposed = true;
			await rt.loading;
			await rt.live?.kernel.dispose(options);
			rt.live = null;
		},
	};
}
