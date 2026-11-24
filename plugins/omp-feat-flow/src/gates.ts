import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readProject, sha256Hex, type ProjectConfigV2 } from "./config";
import { executeFinish } from "./delivery-saga";
import { defaultUiFromHost, effectiveLinearMode, type FlowRuntime } from "./flow-context";
import { runHelper } from "./helpers";
import { proposeKnowledge } from "./knowledge";
import { linearClient, resolveLinearKey } from "./linear";
import { applyGate1Overrides, type AlignmentDocument } from "./profile";
import {
	alignmentColdReadPrompt,
	approvalPacket,
	knowledgeColdReadPrompt,
	parseAlignmentColdReadVerdict,
	parseKnowledgeColdReadVerdict,
	validateApprovalPacket,
} from "./questions";
import type { AutoDeliverGrant, ColdReadProof, RunView } from "./run";
import { renderTechDesignHtml, type AlignmentReadModel } from "./tech-design";

function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export async function runColdReadForCandidate(rt: FlowRuntime, view: RunView, readModel?: AlignmentReadModel): Promise<ColdReadProof> {
	const activeAmend = view.pendingAmendment && view.pendingAmendment.candidate.digest === view.candidate?.digest
		? view.pendingAmendment
		: null;
	const candidate = activeAmend?.candidate ?? view.candidate!;
	const effectiveProfile = activeAmend?.profile ?? view.profile;
	const effectivePlan = activeAmend?.plan ?? view.plan;
	const material = JSON.parse(readFileSync(candidate.contentPath, "utf8")) as { content?: unknown; scope?: unknown };
	const packet = approvalPacket({
		runId: view.runId,
		candidateRevision: candidate.revision,
		content: String(material.content),
		scope: String(material.scope),
		base: view.currentIntegrationSha,
	});
	// Decision D1: deterministic host check on the fixed approval packet template (no redundant LLM call).
	validateApprovalPacket(packet);

	// Small tier fast path (Decision A1): skip LLM cold-read and rely on crisp host-rendered Gate 1 summary.
	if (effectiveProfile?.tier === "small") {
		return {
			kind: "packet",
			candidateDigest: candidate.digest,
			readModelDigest: packet.id,
			verdict: "PASS",
			summary: `Small-tier host-validated gate (${effectivePlan?.slices.length ?? 1} slice, ${effectiveProfile.declaredFiles.length} declared files).`,
		};
	}

	const modelToRead = readModel ?? rt.loadAlignmentReadModel(view);
	if (!modelToRead) {
		if (view.profile) {
			throw new Error("Alignment document read-model is missing on disk; re-submit the plan before approving.");
		}
		return {
			kind: "packet",
			candidateDigest: candidate.digest,
			readModelDigest: packet.id,
			verdict: "PASS",
			summary: "Host-validated approval packet.",
		};
	}

	const helperCfg = rt.roleModelAndEffort("coldReader");
	const docCold = await runHelper(rt.host.helperSdk(), {
		kind: "cold-read",
		cwd: view.worktree,
		prompt: alignmentColdReadPrompt(modelToRead),
		...helperCfg,
		binding: { taskId: view.runId, epoch: view.ownerEpoch, snapshotDigest: view.scopePolicyDigest },
	});
	const docVerdict = parseAlignmentColdReadVerdict(docCold.text, modelToRead);
	if (docVerdict.verdict !== "PASS") {
		throw new Error(`Alignment document cold-read failed (${docVerdict.verdict}): ${docVerdict.missing.concat(docVerdict.bloat).join("; ")}`);
	}
	return {
		kind: "alignment-doc",
		candidateDigest: candidate.digest,
		readModelDigest: modelToRead.digest,
		verdict: "PASS",
		summary: docVerdict.summary,
	};
}

export async function ensureLinearIssueForApproval(
	rt: FlowRuntime,
	view: RunView,
	proj: ProjectConfigV2 | undefined,
): Promise<void> {
	const linearMode = effectiveLinearMode(proj);
	if (linearMode === "disabled" || view.issue) return;
	const teamId = proj?.linear?.teamId;
	if (!teamId && linearMode === "required") {
		throw new Error("Linear issue required before implementation, but project.linear.teamId is not configured.");
	}
	const ui = defaultUiFromHost(rt.host);
	const key = process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE === "1" ? null : await resolveLinearKey();
	if (!key || !teamId) {
		if (linearMode === "required") {
			throw new Error("Linear issue required before implementation; set LINEAR_API_KEY / keychain omp-linear-api-key or bind an existing ID via /feat-flow-start <ID>.");
		}
		return;
	}
	const client = linearClient(key);
	const originMarker = `feat-flow-origin:${view.runId}:${sha256Hex(view.repoIdentity).slice(0, 12)}`;
	const unsettledIssueOp = view.operations.find(op => op.type === "linear-issue" && (op.status === "dispatched" || op.status === "unknown"));

	// P0-9: reconcile any ambiguous linear-issue creation BEFORE interactive prompts or readiness refusal.
	if (unsettledIssueOp && client.findByOriginMarker) {
		const found = await client.findByOriginMarker(teamId, originMarker);
		if (found.length > 1) {
			throw new Error(`Multiple Linear issues match ${originMarker}; resolve manually.`);
		}
		if (found.length === 1) {
			await rt.live!.kernel.apply({
				kind: "operation.settle",
				operationId: unsettledIssueOp.id,
				outcome: "applied",
				receipt: { target: unsettledIssueOp.target, intentDigest: unsettledIssueOp.intentDigest, reference: found[0]!.identifier },
				boundIssue: { identifier: found[0]!.identifier, id: found[0]!.id },
			}, rt.live!.binding);
			rt.host.notify(`已对账并绑定 ${found[0]!.identifier} (${found[0]!.url})`);
			return;
		}
		await rt.live!.kernel.apply({
			kind: "operation.settle",
			operationId: unsettledIssueOp.id,
			outcome: "not-applied",
			receipt: { target: unsettledIssueOp.target, intentDigest: unsettledIssueOp.intentDigest, reference: "reconciled-absent" },
		}, rt.live!.binding);
	}

	if (!ui.hasUI) {
		if (linearMode === "required") {
			throw new Error("Linear issue required before implementation; bind one with /feat-flow-start <LINEAR-ID> before approving.");
		}
		return;
	}

	const action = await ui.select("此需求尚未绑定 Linear 单", [
		`立即在 ${proj?.linear?.teamKey ?? "团队"} 创建新 Linear 单`,
		"绑定已有 Linear 单号",
		...(linearMode === "optional" ? ["暂跳过（可选模式）"] : []),
	]);
	if (!action) throw new Error("Linear issue required: cancelled issue creation/binding.");
	if (action.startsWith("暂跳过")) return;
	if (action.startsWith("绑定已有")) {
		const rawId = await ui.input("输入 Linear 单号 (例如 DESK-1234):");
		const id = rawId?.trim().toUpperCase();
		if (!id || !/^[A-Z][A-Z0-9]+-\d+$/.test(id)) {
			throw new Error("Invalid Linear issue identifier.");
		}
		const desc = await client.describe(id).catch(() => null);
		if (!desc) throw new Error(`${id} is not readable with the available Linear credential.`);
		if (desc.teamId !== teamId) throw new Error(`${desc.identifier} belongs to another Linear team.`);
		await rt.live!.kernel.apply({ kind: "bindIssue", issue: desc.identifier, issueId: null }, rt.live!.binding);
		return;
	}

	if (!client.fetchTeamMetadata || !client.findByOriginMarker || !client.createIssue) {
		throw new Error("Linear client does not support issue creation metadata queries.");
	}
	const meta = await client.fetchTeamMetadata(teamId);
	const defaultTitle = view.initialTask?.split(/\r?\n/)[0]?.slice(0, 120) || view.approvedScope?.scope || view.candidate?.scope || view.runId;
	const promptFields = proj?.linear?.promptFields ?? ["project", "labels", "priority"];

	let title = defaultTitle;
	let projectId: string | undefined;
	let projectMilestoneId: string | undefined;
	let labelIds: string[] = [];
	let priority: number | undefined;
	let cycleId: string | undefined;

	if (ui.formDialog) {
		const projectNames = ["(none)", ...meta.projects.map(p => p.name)];
		const allMilestones = meta.projects.flatMap(p => p.milestones.map(m => `${p.name} / ${m.name}`));
		const milestoneNames = ["(none)", ...allMilestones];
		const labelNames = meta.labels.map(l => l.name);
		const cycleOptions = meta.activeCycle
			? ["(none)", `Cycle #${meta.activeCycle.number}${meta.activeCycle.name ? ` (${meta.activeCycle.name})` : ""}`]
			: ["(none)"];
		const html = [
			"<form>",
			`<p><strong>创建 Linear 单 (${escapeHtml(meta.team.key)})</strong></p>`,
			`<label>标题 <input type="text" name="title" value="${escapeHtml(defaultTitle)}" required></label>`,
			...(promptFields.includes("project") && meta.projects.length > 0
				? [`<label>Project <select name="project">${projectNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}</select></label>`]
				: []),
			...(promptFields.includes("milestone") && allMilestones.length > 0
				? [`<label>Milestone <select name="milestone">${milestoneNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}</select></label>`]
				: []),
			...(promptFields.includes("priority")
				? [
					`<label>Priority <select name="priority">`
					+ `<option value="0" selected>0 — None</option>`
					+ `<option value="1">1 — Urgent</option>`
					+ `<option value="2">2 — High</option>`
					+ `<option value="3">3 — Normal</option>`
					+ `<option value="4">4 — Low</option></select></label>`,
				]
				: []),
			...(promptFields.includes("cycle") && meta.activeCycle
				? [`<label>Cycle <select name="cycle">${cycleOptions.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("")}</select></label>`]
				: []),
			...(promptFields.includes("labels") && labelNames.length > 0
				? [
					"<fieldset><legend>Labels</legend>",
					...meta.labels.map(l => `<label><input type="checkbox" name="labels" value="${escapeHtml(l.id)}"> ${escapeHtml(l.name)}</label>`),
					"</fieldset>",
				]
				: []),
			"</form>",
		].join("");
		const submitted = await ui.formDialog(html);
		if (!submitted) throw new Error("Cancelled Linear issue creation.");
		title = String(submitted.title ?? defaultTitle).trim() || defaultTitle;
		if (submitted.project && submitted.project !== "(none)") {
			const projObj = meta.projects.find(p => p.name === String(submitted.project));
			projectId = projObj?.id;
		}
		if (submitted.milestone && submitted.milestone !== "(none)") {
			const target = String(submitted.milestone);
			for (const p of meta.projects) {
				const m = p.milestones.find(ms => `${p.name} / ${ms.name}` === target);
				if (m) {
					projectId = projectId ?? p.id;
					projectMilestoneId = m.id;
					break;
				}
			}
		}
		if (submitted.priority !== undefined) {
			const pNum = Number(submitted.priority);
			if (Number.isInteger(pNum) && pNum >= 1 && pNum <= 4) priority = pNum;
		}
		if (submitted.cycle && submitted.cycle !== "(none)" && meta.activeCycle) {
			cycleId = meta.activeCycle.id;
		}
		if (Array.isArray(submitted.labels)) {
			labelIds = submitted.labels.map(String).filter(id => meta.labels.some(l => l.id === id));
		} else if (typeof submitted.labels === "string" && meta.labels.some(l => l.id === submitted.labels)) {
			labelIds = [submitted.labels];
		}
	} else {
		title = (await ui.input("Linear 单标题:", defaultTitle))?.trim() || defaultTitle;
		if (promptFields.includes("project") && meta.projects.length > 0) {
			const picked = await ui.select("关联 Project (可选)", ["(无)", ...meta.projects.map(p => p.name)]);
			projectId = meta.projects.find(p => p.name === picked)?.id;
		}
		if (promptFields.includes("labels") && meta.labels.length > 0) {
			const picked = await ui.select("选择 Label (可选)", ["(无)", ...meta.labels.map(l => l.name)]);
			const found = meta.labels.find(l => l.name === picked);
			if (found) labelIds.push(found.id);
		}
		if (promptFields.includes("priority")) {
			const picked = await ui.select("Priority (可选)", ["0 — None", "1 — Urgent", "2 — High", "3 — Normal", "4 — Low"]);
			const pNum = picked ? Number(picked[0]) : 0;
			if (pNum >= 1 && pNum <= 4) priority = pNum;
		}
	}

	const bodyLines = [
		view.grilling?.decided.map(d => `- **${d.category}**: ${d.answer}`).join("\n") ?? "",
		view.plan ? `\n### Slices\n${view.plan.slices.map(s => `- ${s.id}: ${s.behavior}`).join("\n")}` : "",
		`\n<!-- ${originMarker} -->`,
	].join("\n");

	const freshView = rt.live!.kernel.inspect();
	const intentDigest = sha256Hex(JSON.stringify({ teamId, title, originMarker }));
	const preparedOp = freshView.operations.find(op => op.type === "linear-issue" && op.status === "prepared" && op.intentDigest === intentDigest);
	const opId = preparedOp?.id ?? `linear-issue-${freshView.runId}-r${freshView.revision + 1}`;
	if (preparedOp) {
		await rt.live!.kernel.apply({ kind: "operation.resume", operationId: opId, intentDigest }, rt.live!.binding);
	} else {
		await rt.live!.kernel.apply({ kind: "operation.prepare", operation: { id: opId, type: "linear-issue", target: teamId, intentDigest } }, rt.live!.binding);
	}
	await rt.live!.kernel.apply({ kind: "operation.dispatch", operationId: opId }, rt.live!.binding);

	let created: { id: string; identifier: string; url: string } | undefined;
	try {
		const prior = await client.findByOriginMarker(teamId, originMarker);
		if (prior.length > 1) {
			await rt.live!.kernel.apply({ kind: "operation.unknown", operationId: opId, reason: "Multiple issues match originMarker." }, rt.live!.binding);
			throw new Error(`Multiple Linear issues match ${originMarker}; resolve manually.`);
		}
		created = prior[0] ?? (await client.createIssue({
			teamId,
			title: title.slice(0, 120),
			description: bodyLines,
			assigneeId: meta.viewerId || undefined,
			projectId,
			projectMilestoneId,
			labelIds: labelIds.length > 0 ? labelIds : undefined,
			priority,
			cycleId,
		}));
	} catch (error) {
		const reconciled = await client.findByOriginMarker(teamId, originMarker).catch(() => null);
		if (reconciled && reconciled.length === 1) {
			created = reconciled[0]!;
		} else {
			const activeOp = rt.live!.kernel.inspect().operations.find(op => op.id === opId);
			if (activeOp?.status === "dispatched") {
				await rt.live!.kernel.apply({ kind: "operation.unknown", operationId: opId, reason: error instanceof Error ? error.message : String(error) }, rt.live!.binding);
			}
			throw error;
		}
	}
	await rt.live!.kernel.apply({
		kind: "operation.settle",
		operationId: opId,
		outcome: "applied",
		receipt: { target: teamId, intentDigest, reference: created.identifier },
		boundIssue: { identifier: created.identifier, id: created.id },
	}, rt.live!.binding);
	rt.host.notify(`已创建并绑定 ${created.identifier} (${created.url})`);
}

function summarizeCandidateForHuman(view: RunView, coldSummary: string): { summaryText: string; scopeText: string } {
	const cand = view.candidate!;
	try {
		const material = JSON.parse(readFileSync(cand.contentPath, "utf8")) as { content?: string };
		const parsed = JSON.parse(String(material.content ?? "")) as { summary?: string };
		const summaryText = parsed.summary?.trim() || cand.scope;
		return { summaryText, scopeText: `${cand.scope}\nCold-read: ${coldSummary}` };
	} catch {
		return { summaryText: cand.scope, scopeText: `${cand.scope}\nCold-read: ${coldSummary}` };
	}
}

async function executeKnowledgeApprove(rt: FlowRuntime, before: RunView): Promise<void> {
	const knowledge = before.knowledgeCandidate;
	if (!knowledge) throw new Error("No knowledge candidate is pending approval.");
	const root = resolve(before.worktree);
	const proposal = await proposeKnowledge({ root, candidates: [knowledge] });
	if (!proposal.change) throw new Error(`No knowledge change to approve: ${proposal.reason}`);
	const diffText = proposal.changes.map(change => `## ${change.path} (${change.status})\n${change.diff.join("\n")}`).join("\n\n");
	const cold = await runHelper(rt.host.helperSdk(), {
		kind: "cold-read",
		cwd: before.worktree,
		prompt: knowledgeColdReadPrompt({ path: knowledge.path, reason: knowledge.reason, diffText }),
		...rt.roleModelAndEffort("coldReader"),
		binding: { taskId: rt.live!.runId, epoch: before.ownerEpoch, snapshotDigest: before.configDigest },
	});
	const verdict = parseKnowledgeColdReadVerdict(cold.text);
	if (verdict.verdict !== "PASS") {
		throw new Error(`Knowledge cold-read failed (${verdict.verdict}): ${verdict.summary ?? verdict.rationale ?? "missing/bloat"}`);
	}
	const confirmed = await rt.host.confirm(
		`Knowledge correction for ${rt.live!.runId}`,
		`${diffText}\n\nApproving writes exactly ${knowledge.path} and nothing else.`,
	);
	if (!confirmed) throw new Error("Cancelled: the knowledge file is untouched.");
	const after = rt.live!.kernel.inspect();
	if (after.knowledgeCandidate?.path !== knowledge.path) {
		throw new Error("The knowledge candidate changed while you were deciding; approve it again.");
	}
	await rt.live!.kernel.apply({
		kind: "approve", source: "native-ui", approved: true, runId: rt.live!.runId,
		digest: sha256Hex(JSON.stringify(knowledge)),
		candidateRevision: 0, ownerEpoch: after.ownerEpoch,
		...(after.gateToken ? { gateTokenId: after.gateToken.id } : {}),
	}, rt.live!.binding);
	rt.host.notify(`applied the knowledge correction to ${knowledge.path}; nothing else was granted.`);
}

async function executeCheckpointReview(rt: FlowRuntime, before: RunView): Promise<void> {
	const afterSliceId = before.pendingGate?.afterSliceId ?? before.midCheckpointAfterSliceId ?? "?";
	const slices = before.plan?.slices ?? [];
	const done = slices.filter(s => s.status === "done");
	const remaining = slices.filter(s => s.status !== "done");
	const diffStat = await rt.gitText(before.worktree, ["diff", "--stat", `${before.currentIntegrationSha}..HEAD`]).catch(() => "(diff unavailable)");
	const ui = defaultUiFromHost(rt.host);

	let action: "continue" | "amend" | "cancel" = "continue";
	if (ui.formDialog) {
		const doneHtml = done.map(s => `<li><code>${escapeHtml(s.id)}</code>${s.commitSha ? ` (${escapeHtml(s.commitSha.slice(0, 7))})` : ""}: ${escapeHtml(s.behavior)}</li>`).join("");
		const remHtml = remaining.map(s => `<li><code>${escapeHtml(s.id)}</code>: ${escapeHtml(s.behavior)}</li>`).join("");
		const discHtml = (before.handoff?.discoveries ?? []).map(d => `<li>${escapeHtml(d)}</li>`).join("");
		const html = [
			"<form>",
			`<p><strong>Mid-Implementation Checkpoint — 已完成至切片 <code>${escapeHtml(afterSliceId)}</code></strong></p>`,
			`<p>已完成 (${done.length}/${slices.length})：</p><ul>${doneHtml}</ul>`,
			`<p>剩余切片 (${remaining.length})：</p><ul>${remHtml}</ul>`,
			...(discHtml ? [`<p>途中新发现：</p><ul>${discHtml}</ul>`] : []),
			`<pre>${escapeHtml(diffStat.slice(0, 2000))}</pre>`,
			"<fieldset><legend>下一步决策</legend>",
			`<label>操作 <select name="decision">`
			+ `<option value="continue" selected>确认无偏差，继续推进剩余 ${remaining.length} 个切片</option>`
			+ `<option value="amend">暂停并调整剩余切片方案 (等待 AI 提交 plan.amend)</option>`
			+ `</select></label>`,
			"</fieldset>",
			"</form>",
		].join("");
		const res = await ui.formDialog(html);
		if (!res) action = "cancel";
		else action = res.decision === "amend" ? "amend" : "continue";
	} else {
		const ok = await rt.host.confirm(
			`Mid-Checkpoint after ${afterSliceId} (${done.length}/${slices.length} done)`,
			`${diffStat.slice(0, 600)}\n\nContinue remaining ${remaining.length} slice(s)?`,
		);
		action = ok ? "continue" : "amend";
	}

	if (action === "cancel") throw new Error("Cancelled mid-checkpoint review; writes remain paused.");
	if (action === "amend") {
		rt.host.notify(`Mid-Checkpoint 保持暂停：请指示 AI 基于新发现调用 feat_flow_request({ amendPlan: true, plan, ... }) 修改剩余方案。`);
		return;
	}
	await rt.live!.kernel.apply({ kind: "checkpoint.continue" }, rt.live!.binding);
	rt.host.notify(`Mid-Checkpoint 已通过，继续执行剩余 ${remaining.length} 个切片。`);
}

async function executeAmendmentApprove(rt: FlowRuntime, before: RunView): Promise<void> {
	const amend = before.pendingAmendment;
	if (!amend) throw new Error("No pending plan amendment to approve.");
	const cand = amend.candidate;
	let coldProof = before.coldReadProof?.candidateDigest === cand.digest ? before.coldReadProof : null;
	if (!coldProof) {
		if (rt.backgroundColdRead?.digest === cand.digest) {
			coldProof = await rt.backgroundColdRead.promise;
		} else {
			coldProof = await runColdReadForCandidate(rt, before, rt.loadAlignmentReadModel(before));
		}
		await rt.live!.kernel.apply({ kind: "coldRead.record", proof: coldProof }, rt.live!.binding);
	}

	const ui = defaultUiFromHost(rt.host);
	const prevProfile = before.profile;
	const nextProfileBase = amend.profile ?? prevProfile;
	const tierDelta = prevProfile && nextProfileBase && prevProfile.tier !== nextProfileBase.tier
		? `⚠️ Tier 变更: ${prevProfile.tier.toUpperCase()} -> ${nextProfileBase.tier.toUpperCase()}`
		: `Tier: ${(nextProfileBase?.tier ?? "medium").toUpperCase()}`;
	const secDelta = prevProfile?.reviews.security.enabled && nextProfileBase && !nextProfileBase.reviews.security.enabled
		? "⚠️ 原 Security Review ON 试图关闭"
		: `Security: ${nextProfileBase?.reviews.security.enabled ? "ON" : "OFF"}`;
	const perfDelta = prevProfile?.reviews.performance.enabled && nextProfileBase && !nextProfileBase.reviews.performance.enabled
		? "⚠️ 原 Performance Review ON 试图关闭"
		: `Performance: ${nextProfileBase?.reviews.performance.enabled ? "ON" : "OFF"}`;

	let secOverride: boolean | undefined;
	let perfOverride: boolean | undefined;
	if (ui.formDialog) {
		while (true) {
			const sliceList = amend.plan.slices.map(s =>
				`<li><code>${escapeHtml(s.id)}</code>${s.status === "done" ? " [DONE]" : " [NEW/PENDING]"}: ${escapeHtml(s.behavior)}</li>`,
			).join("");
			const html = [
				"<form>",
				`<p><strong>审批中期方案调整 (${escapeHtml(rt.live!.runId)} r${cand.revision})</strong></p>`,
				`<p><strong>摘要：</strong>${escapeHtml(amend.summary ?? cand.scope)}</p>`,
				`<p>${escapeHtml(tierDelta)} · ${escapeHtml(secDelta)} · ${escapeHtml(perfDelta)}</p>`,
				...(amend.techDesignHtmlPath ? [`<p><strong>设计视图：</strong><code>${escapeHtml(amend.techDesignHtmlPath)}</code></p>`] : []),
				`<ul>${sliceList}</ul>`,
				"<fieldset><legend>调整审批</legend>",
				`<label>操作 <select name="decision">`
				+ `<option value="approve" selected>批准方案调整并继续剩余实现</option>`
				+ (amend.techDesignHtmlPath ? `<option value="open_design">重新打开 tech-design.html 查看调整图</option>` : "")
				+ `<option value="reject">退回本次调整（保留原已批准方案）</option>`
				+ `</select></label>`,
				`<label>Security 审计 <select name="securityReview"><option value="keep" selected>保持</option><option value="force_on">强制开启</option><option value="waive_off">豁免关闭</option></select></label>`,
				`<label>Performance 审计 <select name="performanceReview"><option value="keep" selected>保持</option><option value="force_on">强制开启</option><option value="waive_off">豁免关闭</option></select></label>`,
				"</fieldset>",
				"</form>",
			].join("");
			const res = await ui.formDialog(html);
			if (!res) throw new Error("Cancelled amendment decision.");
			if (res.decision === "open_design" && amend.techDesignHtmlPath) {
				await rt.host.openExternal?.(amend.techDesignHtmlPath).catch(() => false);
				continue;
			}
			if (res.decision === "reject") {
				await rt.live!.kernel.apply({ kind: "amendment.cancel" }, rt.live!.binding);
				rt.host.notify("已退回方案调整，原批准方案与已完成切片保持不变。");
				return;
			}
			if (res.securityReview === "force_on") secOverride = true;
			else if (res.securityReview === "waive_off") secOverride = false;
			if (res.performanceReview === "force_on") perfOverride = true;
			else if (res.performanceReview === "waive_off") perfOverride = false;
			break;
		}
	} else {
		const ok = await rt.host.confirm(
			`Approve plan amendment for ${rt.live!.runId} (r${cand.revision})?`,
			`${amend.summary ?? cand.scope}\n${tierDelta} | ${secDelta} | ${perfDelta}`,
		);
		if (!ok) {
			await rt.live!.kernel.apply({ kind: "amendment.cancel" }, rt.live!.binding);
			return;
		}
	}

	if (nextProfileBase && (secOverride !== undefined || perfOverride !== undefined)) {
		const updatedProfile = applyGate1Overrides(nextProfileBase, {
			...(secOverride !== undefined ? { securityEnabled: secOverride } : {}),
			...(perfOverride !== undefined ? { performanceEnabled: perfOverride } : {}),
		});
		await rt.live!.kernel.apply({ kind: "profile.override", profile: updatedProfile, autoDeliverGrant: null }, rt.live!.binding);
	}

	const after = rt.live!.kernel.inspect();
	await rt.live!.kernel.apply({
		kind: "approve", source: "native-ui", approved: true, runId: rt.live!.runId,
		digest: cand.digest, candidateRevision: cand.revision, ownerEpoch: after.ownerEpoch,
		...(after.gateToken ? { gateTokenId: after.gateToken.id } : {}),
	}, rt.live!.binding);
	rt.host.notify(`approved plan amendment r${cand.revision} for ${rt.live!.runId}.`);
}

export async function executeApprove(rt: FlowRuntime): Promise<void> {
	await rt.ensureLoaded();
	if (!rt.live) throw new Error(`No run is available: ${rt.unavailable ?? "run-loading"}.`);
	const before = rt.live.kernel.inspect();
	const gateKind = before.pendingGate?.kind ?? before.gateToken?.kind
		?? (before.knowledgeCandidate ? "knowledge-approval" : "plan-approval");

	if (gateKind === "knowledge-approval") {
		await executeKnowledgeApprove(rt, before);
		return;
	}
	if (gateKind === "checkpoint-review") {
		await executeCheckpointReview(rt, before);
		return;
	}
	if (gateKind === "amendment-approval") {
		await executeAmendmentApprove(rt, before);
		return;
	}
	if (gateKind === "delivery") {
		const ok = await decideGate(rt, before.gateToken ? { tokenId: before.gateToken.id } : undefined);
		if (!ok) throw new Error("Delivery confirmation was cancelled.");
		return;
	}

	const candidate = before.candidate;
	if (!candidate) throw new Error("There is no candidate proposal to approve.");
	if (before.phase !== "alignment") {
		throw new Error(`Cannot approve design while run is in phase "${before.phase}".`);
	}

	const proj = before.project?.config ?? readProject(before.commonDir)?.config;
	const onlyLinearUnsettled = before.waitingReason === "operation-result-unknown"
		&& before.operations.filter(op => op.status === "dispatched" || op.status === "unknown").every(op => op.type === "linear-issue");
	if (onlyLinearUnsettled) {
		await ensureLinearIssueForApproval(rt, before, proj);
	}
	const readyBefore = rt.live.kernel.inspect();
	if (readyBefore.readiness !== "ready") {
		throw new Error(`Recovery is not ready (${readyBefore.waitingReason ?? readyBefore.readiness}); approve is refused.`);
	}

	let coldProof = readyBefore.coldReadProof?.candidateDigest === candidate.digest ? readyBefore.coldReadProof : null;
	if (!coldProof) {
		if (rt.backgroundColdRead?.digest === candidate.digest) {
			coldProof = await rt.backgroundColdRead.promise;
		} else {
			coldProof = await runColdReadForCandidate(rt, readyBefore, rt.loadAlignmentReadModel(readyBefore));
		}
		await rt.live.kernel.apply({ kind: "coldRead.record", proof: coldProof }, rt.live.binding);
	}

	const ui = defaultUiFromHost(rt.host);
	const profile = readyBefore.profile;
	const slices = readyBefore.plan?.slices ?? [];
	const activities = readyBefore.plan?.activities ?? [];
	const offerCadence = (profile?.tier === "large" || slices.length >= 4 || activities.length > 0) && slices.length >= 2;
	const defaultMidSlice = activities.some(a => a.kind === "prototype" || a.kind === "research")
		? slices[0]!.id
		: slices[Math.max(0, Math.ceil(slices.length / 2) - 1)]?.id ?? null;

	const { summaryText } = summarizeCandidateForHuman(readyBefore, coldProof.summary);
	const canAutoDeliver = profile?.tier === "small" && profile.declaredFiles.length > 0;
	let humanAutoDeliver = false;
	let secOverride: boolean | undefined;
	let perfOverride: boolean | undefined;
	let chosenMidSliceId: string | null = null;

	if (ui.formDialog) {
		while (true) {
			const tierText = profile ? `${profile.tier.toUpperCase()} (${profile.tierSource})` : "MEDIUM";
			const secStatus = profile?.reviews.security.enabled ? `ON (${profile.reviews.security.reason})` : `OFF (${profile?.reviews.security.reason ?? "none"})`;
			const perfStatus = profile?.reviews.performance.enabled ? `ON (${profile.reviews.performance.reason})` : `OFF (${profile?.reviews.performance.reason ?? "none"})`;
			const sliceList = slices.map(s => `<li><code>${escapeHtml(s.id)}</code>: ${escapeHtml(s.behavior)}</li>`).join("");
			const actList = activities.map(a => `<li><b>${escapeHtml(a.kind)}</b> (<code>${escapeHtml(a.seam)}</code>): ${escapeHtml(a.reason)}</li>`).join("");
			const html = [
				"<form>",
				`<p><strong>Gate 1 — 审批设计方案 (${escapeHtml(rt.live.runId)} r${candidate.revision})</strong></p>`,
				`<p><strong>摘要：</strong>${escapeHtml(summaryText)}</p>`,
				`<p><strong>范围：</strong><code>${escapeHtml(candidate.scope)}</code> · <strong>分级：</strong>${escapeHtml(tierText)} · <strong>Linear：</strong>${escapeHtml(effectiveLinearMode(proj))}${readyBefore.issue ? ` (${escapeHtml(readyBefore.issue)})` : ""}</p>`,
				`<p><strong>Security Review：</strong>${escapeHtml(secStatus)}<br><strong>Performance Review：</strong>${escapeHtml(perfStatus)}</p>`,
				...(readyBefore.techDesignHtmlPath ? [`<p><strong>设计视图：</strong><code>${escapeHtml(readyBefore.techDesignHtmlPath)}</code></p>`] : []),
				...(actList ? [`<p><strong>前置不确定性活动：</strong></p><ul>${actList}</ul>`] : []),
				...(sliceList ? [`<ul>${sliceList}</ul>`] : []),
				"<fieldset><legend>审批决策</legend>",
				`<label>操作 <select name="decision">`
				+ `<option value="approve" selected>批准进入实现（保持 Gate 2 人工交付确认）</option>`
				+ (canAutoDeliver ? `<option value="approve_auto">批准并在不超声明文件时自动交付 (${profile!.declaredFiles.length} 文件)</option>` : "")
				+ (readyBefore.techDesignHtmlPath ? `<option value="open_design">重新打开 tech-design.html 查看流程图</option>` : "")
				+ `<option value="cancel">暂不批准（留在对齐阶段）</option>`
				+ `</select></label>`,
				...(offerCadence ? [
					`<label>大型/多切片执行节奏 <select name="cadence">`
					+ `<option value="full"${activities.length === 0 ? " selected" : ""}>全程自动推进至 Gate 2 交付前确认（2 个 Gate）</option>`
					+ `<option value="mid"${activities.length > 0 ? " selected" : ""}>启用中段复核（在切片${defaultMidSlice ? ` ${escapeHtml(defaultMidSlice)}` : ""}完成后暂停检查）</option>`
					+ `</select></label>`,
				] : []),
				`<label>Security 独立审计覆写 <select name="securityReview">`
				+ `<option value="keep" selected>保持当前 (${profile?.reviews.security.enabled ? "ON" : "OFF"})</option>`
				+ `<option value="force_on">强制开启 Security Review</option>`
				+ `<option value="waive_off">人工豁免关闭</option>`
				+ `</select></label>`,
				`<label>Performance 独立审计覆写 <select name="performanceReview">`
				+ `<option value="keep" selected>保持当前 (${profile?.reviews.performance.enabled ? "ON" : "OFF"})</option>`
				+ `<option value="force_on">强制开启 Performance Review</option>`
				+ `<option value="waive_off">人工豁免关闭</option>`
				+ `</select></label>`,
				"</fieldset>",
				"</form>",
			].join("");

			const res = await ui.formDialog(html);
			if (!res || res.decision === "cancel") {
				throw new Error("Cancelled: implementation stays closed.");
			}
			if (res.decision === "open_design" && readyBefore.techDesignHtmlPath) {
				const opened = rt.host.openExternal ? await rt.host.openExternal(readyBefore.techDesignHtmlPath) : false;
				rt.host.notify(opened ? `Opened: ${readyBefore.techDesignHtmlPath}` : `Design HTML: ${readyBefore.techDesignHtmlPath}`);
				continue;
			}
			humanAutoDeliver = canAutoDeliver && res.decision === "approve_auto";
			if (offerCadence && res.cadence === "mid" && defaultMidSlice) {
				chosenMidSliceId = defaultMidSlice;
			}
			if (res.securityReview === "force_on") secOverride = true;
			else if (res.securityReview === "waive_off") secOverride = false;
			if (res.performanceReview === "force_on") perfOverride = true;
			else if (res.performanceReview === "waive_off") perfOverride = false;
			break;
		}
	} else {
		const lines = [
			`Summary: ${summaryText}`,
			`Scope: ${candidate.scope}`,
			`Tier: ${profile ? `${profile.tier.toUpperCase()} (${profile.tierSource})` : "medium"} | Slices: ${slices.length}`,
			`Security review: ${profile?.reviews.security.enabled ? "ON" : "OFF"} | Performance review: ${profile?.reviews.performance.enabled ? "ON" : "OFF"}`,
			...(readyBefore.techDesignHtmlPath ? [`Design HTML: ${readyBefore.techDesignHtmlPath}`] : []),
			`Cold-read: ${coldProof.summary.slice(0, 240)}`,
			"Permits implementation writes inside the stated scope only (never merge/publish/deliver).",
		];
		const confirmed = await rt.host.confirm(`Approve ${rt.live.runId} (r${candidate.revision})?`, lines.join("\n"));
		if (!confirmed) throw new Error("Cancelled: implementation stays closed.");
	}

	if (chosenMidSliceId !== null || readyBefore.midCheckpointAfterSliceId !== null) {
		await rt.live.kernel.apply({ kind: "cadence.set", midCheckpointAfterSliceId: chosenMidSliceId }, rt.live.binding);
	}

	if (profile && (secOverride !== undefined || perfOverride !== undefined || humanAutoDeliver || chosenMidSliceId)) {
		const nextProfile = applyGate1Overrides(profile, {
			...(secOverride !== undefined ? { securityEnabled: secOverride } : {}),
			...(perfOverride !== undefined ? { performanceEnabled: perfOverride } : {}),
			autoDeliver: humanAutoDeliver,
		});
		const grant: AutoDeliverGrant | null = humanAutoDeliver && nextProfile.autoDeliver
			? { candidateDigest: candidate.digest, declaredFiles: [...nextProfile.declaredFiles], grantedByHuman: true, revoked: false }
			: null;
		if (secOverride !== undefined || perfOverride !== undefined || humanAutoDeliver) {
			await rt.live.kernel.apply({ kind: "profile.override", profile: nextProfile, autoDeliverGrant: grant }, rt.live.binding);
		}
		// Re-render tech-design.html if human toggled Security/Perf, Auto-Deliver, or Mid-Checkpoint so HTML stays accurate.
		if (readyBefore.alignmentDocPath && readyBefore.techDesignHtmlPath && existsSync(readyBefore.alignmentDocPath)) {
			try {
				const rawDoc = JSON.parse(readFileSync(readyBefore.alignmentDocPath, "utf8")) as {
					doc?: AlignmentDocument;
					meta?: Parameters<typeof renderTechDesignHtml>[2];
				};
				if (rawDoc.doc && rawDoc.meta) {
					await Bun.write(readyBefore.techDesignHtmlPath, renderTechDesignHtml(rawDoc.doc, nextProfile, {
						...rawDoc.meta,
						midCheckpointAfterSliceId: chosenMidSliceId,
					}));
				}
			} catch { /* ignore HTML refresh failure */ }
		}
	}

	await ensureLinearIssueForApproval(rt, rt.live.kernel.inspect(), proj);

	const after = rt.live.kernel.inspect();
	if (after.readiness !== "ready" || after.candidate?.digest !== candidate.digest || after.candidate.revision !== candidate.revision) {
		throw new Error("The candidate changed while you were deciding; approve the current one again.");
	}
	await rt.live.kernel.apply({
		kind: "approve", source: "native-ui", approved: true, runId: rt.live.runId,
		digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: after.ownerEpoch,
		...(after.gateToken ? { gateTokenId: after.gateToken.id } : {}),
	}, rt.live.binding);

	const approvedView = rt.live.kernel.inspect();
	const usage = rt.host.contextUsage?.();
	const stageClearPct = proj?.context?.stageClearPct ?? 25;
	if ((usage && usage.percent >= stageClearPct) || (approvedView.plan?.slices.length ?? 0) >= 3) {
		rt.host.notify(`approved ${rt.live.runId} r${candidate.revision}. 建议：当前上下文 ${Math.round(usage?.percent ?? 0)}%（或 ≥3 切片），可先敲 /clear 后说「继续」轻装开始第 1 切片。`);
	} else {
		rt.host.notify(`approved ${rt.live.runId} revision ${candidate.revision}.`);
	}
}

export async function decideGate(rt: FlowRuntime, options?: { tokenId?: string; silentAuto?: boolean }): Promise<boolean> {
	if (!rt.isMainAgent() || !rt.live) return false;
	if (rt.pendingCheckPersist) await rt.pendingCheckPersist;
	const view = rt.live.kernel.inspect();
	const token = view.gateToken;
	if (!token) return false;
	if (options?.tokenId && token.id !== options.tokenId) return false;

	if (
		token.kind === "plan-approval"
		|| token.kind === "knowledge-approval"
		|| token.kind === "checkpoint-review"
		|| token.kind === "amendment-approval"
	) {
		await executeApprove(rt);
		return true;
	}
	if (token.kind === "delivery") {
		const grant = view.autoDeliverGrant;
		if (options?.silentAuto && grant?.grantedByHuman === true && !grant.revoked && grant.candidateDigest === view.approvedScope?.digest) {
			const head = rt.gitHead(view.worktree);
			const dirty = (await rt.gitText(view.worktree, ["status", "--porcelain"])).trim();
			const slicesDone = !view.plan || view.plan.slices.every(s => s.status === "done");
			const checkOk = view.lastVerifiedCheckHead === head || Boolean(view.plan?.slices.some(s => s.status === "done" && s.commitSha === head));
			const scopeCheck = await rt.checkChangedFilesWithinDeclared(view, head, grant.declaredFiles);
			if (!dirty && slicesDone && checkOk && scopeCheck.ok) {
				await executeFinish(rt, { skipAutoDeliverConfirm: true });
				return true;
			}
			await rt.live.kernel.apply({ kind: "autoDeliver.revoke" }, rt.live.binding);
			rt.host.notify(
				`Auto-deliver revoked before delivery (${dirty ? "dirty tree" : !slicesDone ? "pending slices" : !checkOk ? "unverified HEAD" : `extra files: ${scopeCheck.extra.join(", ")}`}); human confirmation required.`,
				"warning",
			);
		}
		const confirmed = await rt.host.confirm(
			`Deliver ${view.runId}?`,
			"Run base sync, independent review (+ sec/perf if enabled), git push, single PR, and Linear backwrite?",
		);
		if (!confirmed) return false;
		await executeFinish(rt);
		return true;
	}
	return false;
}
