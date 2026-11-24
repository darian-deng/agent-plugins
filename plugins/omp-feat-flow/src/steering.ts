import type { ContextUsage } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STEERING_INTENT_HINTS } from "./intents";
import type { AlignmentDocument } from "./profile";
import type { RunView } from "./run";
export interface GitRecoverySnapshot {
	head: string;
	logOneline: string[];
	dirtyFiles: string[];
}

export interface StageWidgetView {
	statusText: string;
	lines: [string, string, string];
}

function activeSlice(view: RunView) {
	if (!view.plan) return null;
	return view.plan.slices.find(s => s.status !== "done") ?? null;
}

export function buildStageWidget(view: RunView, usage: ContextUsage | undefined): StageWidgetView {
	const pct = usage ? `${Math.round(usage.percent)}%` : "--";
	const issueLabel = view.issue ?? (view.project?.config.linear?.mode === "disabled" ? "GH-only" : "未绑单");
	const tierLabel = view.profile ? `${view.profile.tier}` : "align";
	const totalSlices = view.plan?.slices.length ?? 0;
	const doneSlices = view.plan?.slices.filter(s => s.status === "done").length ?? 0;
	const nextSlice = activeSlice(view);
	const sliceTag = totalSlices > 0 ? `[${Math.min(doneSlices + (nextSlice ? 1 : 0), totalSlices)}/${totalSlices}]` : "";

	let chain = "";
	if (view.phase === "alignment") {
		chain = view.gateToken?.kind === "plan-approval"
			? "✓ 对齐 ── ◉ 方案待批 ── ○ 实现 ── ○ 交付"
			: "◉ 对齐 ── ○ 方案 ── ○ 实现 ── ○ 交付";
	} else if (view.phase === "implementation") {
		const gKind = view.pendingGate?.kind ?? view.gateToken?.kind;
		chain = gKind === "delivery"
			? `✓ 对齐 ── ✓ 方案 ── ✓ 实现 ${sliceTag} ── ◉ 交付待批`
			: gKind === "checkpoint-review"
				? `✓ 对齐 ── ✓ 方案 ── ⏸ 中段复核 ${sliceTag} ── ○ 交付`
				: gKind === "amendment-approval"
					? `✓ 对齐 ── ◉ 方案调整待批 ── ○ 实现 ${sliceTag} ── ○ 交付`
					: `✓ 对齐 ── ✓ 方案 ── ◉ 实现 ${sliceTag} ── ○ 交付`;
	} else if (view.phase === "delivery") {
		chain = "✓ 对齐 ── ✓ 方案 ── ✓ 实现 ── ◉ 交付中";
	} else {
		chain = "✓ 对齐 ── ✓ 方案 ── ✓ 实现 ── ✓ 已交付";
	}

	const line1 = `${chain} │ ${issueLabel} │ ${tierLabel} │ ctx ${pct}`;

	let line2 = "";
	const gateKind = view.pendingGate?.kind ?? view.gateToken?.kind;
	if (view.knowledgeCandidate) {
		line2 = `待批知识更新：${view.knowledgeCandidate.path}`;
	} else if (gateKind === "checkpoint-review") {
		line2 = `中段复核点 (${view.pendingGate?.afterSliceId ?? ""}) — 查看进度或调整剩余切片`;
	} else if (gateKind === "amendment-approval") {
		line2 = `方案调整待批 (${view.pendingAmendment?.plan.slices.length ?? totalSlices} 个切片)`;
	} else if (view.phase === "alignment") {
		const open = view.grilling?.open ?? ["goals", "non-goals", "business-boundary", "error-path", "acceptance"];
		line2 = gateKind === "plan-approval"
			? `已生成方案 (${totalSlices} 个串行切片) · 已自动输出设计视图`
			: view.initialTask
				? `需求：${view.initialTask.replace(/\s+/g, " ").slice(0, 48)}`
				: `未决边界 (${open.length}/5): ${open.join(", ") || "无"}`;
	} else if (view.phase === "implementation") {
		line2 = nextSlice
			? `当前切片 ${nextSlice.id}: ${nextSlice.behavior}`
			: `全部 ${totalSlices} 个切片已完成`;
	} else if (view.phase === "delivery") {
		line2 = "正在执行同步、独立审查、PR 创建与 Linear 回写";
	} else {
		line2 = "交付已完成，可在下方选择 Retro 或工作区收尾";
	}

	let line3 = "";
	if (view.readiness === "blocked") {
		line3 = `⛔ 阻塞中 (${view.waitingReason ?? "blocked"}) — 运行 /feat-flow-start 或 /feat-flow-status 恢复`;
	} else if (view.contextWrapUp) {
		line3 = view.contextWrapUp.checkpointed
			? "✓ 断点已保存 · 随时敲 /clear 后直接说「继续」接续下一切片"
			: `⚠️ 上下文 ${Math.round(view.contextWrapUp.atPct)}% — AI 正在收尾当前切片并保存断点`;
	} else if (view.gateToken || view.pendingGate) {
		const cmdHint = gateKind === "delivery" ? "/feat-flow-finish" : "/feat-flow-approve";
		line3 = `⏸ 等你 Gate 拍板：按弹出框确认（或聊完后敲 ${cmdHint}）`;
	} else if (view.phase === "alignment") {
		line3 = "💬 自由对话收敛边界（AI 收齐后将自动生成并打开 HTML 方案视图）";
	} else if (view.phase === "implementation") {
		line3 = `🤖 AI 正在自动串行推进切片${sliceTag}（无需操作；随时可发消息纠偏）`;
	} else if (view.phase === "delivery") {
		line3 = "⏳ 交付事务执行中…";
	} else {
		line3 = "✅ 已交付（可运行 Retro 沉淀规则或关闭工作区）";
	}

	const statusText = `feat-flow: ${issueLabel} │ ${view.phase}${sliceTag} │ ctx ${pct}`;
	return { statusText, lines: [line1, line2, line3] };
}

function readAlignmentSummaryForBrief(view: RunView): string[] {
	const docPath = view.alignmentDocPath;
	if (!docPath || !existsSync(docPath)) return [];
	try {
		const parsed = JSON.parse(readFileSync(docPath, "utf8")) as { doc?: AlignmentDocument };
		const doc = parsed.doc;
		if (!doc) return [];
		const lines = [
			"",
			"Approved Architecture & Contracts:",
			`- TL;DR: ${doc.tldr.slice(0, 240)}`,
			`- Mechanism: ${doc.mechanism.overview.slice(0, 320)}`,
			...doc.mechanism.contracts.slice(0, 10).map(c => `- Contract: ${c.slice(0, 200)}`),
			...doc.mechanism.failureModes.slice(0, 8).map(f => `- Failure mode: ${f.slice(0, 200)}`),
			`- Persistence/Migration: ${doc.mechanism.persistenceOrMigration.slice(0, 200)}`,
			`- Change Surface: ${doc.changeSurface.slice(0, 12).map(r => `[${r.action}] ${r.path}`).join(", ")}`,
		];
		if (view.profile) {
			lines.push(
				`- Reviews: Security=${view.profile.reviews.security.enabled ? "ON" : "OFF"}, Performance=${view.profile.reviews.performance.enabled ? "ON" : "OFF"}`,
			);
		}
		return lines;
	} catch {
		return [];
	}
}

export function buildRecoveryBrief(view: RunView, gitSnap: GitRecoverySnapshot, packDir: string | null): string {
	const decided = view.grilling?.decided.map(d => `- ${d.category}: ${d.answer}`).join("\n") || "- (none)";
	const open = view.grilling?.open ?? [];
	const slices = view.plan?.slices.map(s => {
		const mark = s.status === "done" ? "[x]" : s.status === "in_progress" ? "[>]" : s.status === "partial" ? "[~]" : "[ ]";
		const extra = s.commitSha ? ` (${s.commitSha.slice(0, 7)})` : s.remaining ? ` (remaining: ${s.remaining})` : "";
		return `${mark} ${s.id}${extra} — ${s.behavior} | test: ${s.test}`;
	}).join("\n") || "(no plan yet)";

	const lines = [
		`=== feat-flow Recovery Brief (${view.runId} r${view.revision}) ===`,
		`Phase: ${view.phase} | Readiness: ${view.readiness}${view.waitingReason ? ` (${view.waitingReason})` : ""}`,
		`Issue: ${view.issue ?? "unbound"} | Branch: ${view.branch} -> ${view.git.prBase} | HEAD: ${gitSnap.head.slice(0, 12)}`,
		...(view.initialTask ? [`Initial Requirement: ${view.initialTask}`] : []),
		`Approved Scope: ${view.approvedScope?.scope ?? "(not yet approved)"}`,
		...(view.midCheckpointAfterSliceId ? [`Mid-Checkpoint: after ${view.midCheckpointAfterSliceId} (${view.midCheckpointCompleted ? "completed" : "pending"})`] : []),
		"",
		"Decided Boundaries:",
		decided,
	];
	if (open.length > 0) lines.push(`Open Boundaries: ${open.join(", ")}`);
	lines.push(...readAlignmentSummaryForBrief(view));
	lines.push("", "Slices:", slices);
	if (gitSnap.logOneline.length > 0) lines.push("", "Commits on branch:", ...gitSnap.logOneline.slice(0, 15));
	if (gitSnap.dirtyFiles.length > 0) lines.push("", "Uncommitted changes:", ...gitSnap.dirtyFiles.slice(0, 20));
	if (view.handoff) {
		lines.push(
			"",
			`Handoff (${view.handoff.reason}): ${view.handoff.currentState}`,
			...(view.handoff.remainingInSlice ? [`Remaining in slice: ${view.handoff.remainingInSlice}`] : []),
			...(view.handoff.discoveries.length > 0 ? ["Discoveries:", ...view.handoff.discoveries.map(d => `- ${d}`)] : []),
			...(view.handoff.pendingQuestions.length > 0 ? ["Pending questions:", ...view.handoff.pendingQuestions.map(q => `- ${q}`)] : []),
			...(view.handoff.lastVerification ? [`Last verification: ${view.handoff.lastVerification}`] : []),
		);
	}
	if (packDir) {
		const activeMethod = view.phase === "alignment" ? "grilling" : view.phase === "implementation" ? "tdd" : "code-review";
		lines.push("", `Private MethodPack (${activeMethod}): ${join(packDir, activeMethod, "SKILL.md")}`);
	}
	return lines.join("\n");
}

export function buildStagePrompt(view: RunView, usage: ContextUsage | undefined, packDir: string | null): string {
	const pct = usage ? `${Math.round(usage.percent)}%` : "unknown";
	const methodFile = (name: string, file = "SKILL.md") => (packDir ? join(packDir, name, file) : `resources/skills/${name}/${file}`);
	const gateKind = view.pendingGate?.kind ?? view.gateToken?.kind;

	if (view.contextWrapUp) {
		if (view.contextWrapUp.checkpointed) {
			return [
				`[feat-flow · Checkpoint Saved · ctx ${pct}]`,
				"Checkpoint is already saved. Do not start new edits; tell the user to run /clear and say '继续' to resume cleanly.",
			].join("\n");
		}
		return [
			`[feat-flow · ${view.contextWrapUp.mode === "finalizing_slice" ? "FINALIZING_SLICE" : "WRAP_UP"} · ctx ${pct}]`,
			"Context budget threshold reached. New behavior edits are locked.",
			view.contextWrapUp.mode === "finalizing_slice"
				? `You may finish running tests and git commit ONLY for the active slice, then MUST call ${STEERING_INTENT_HINTS.checkpoint}.`
				: `Call ${STEERING_INTENT_HINTS.checkpoint} with your exact current state and discoveries.`,
			"End your reply by telling the user: checkpoint is saved — run /clear and say '继续' to resume seamlessly.",
		].join("\n");
	}

	if (gateKind === "knowledge-approval") {
		return [
			`[feat-flow · Knowledge Gate Pending · ${view.runId}]`,
			`Knowledge update (${view.knowledgeCandidate?.path ?? "unknown"}) awaits human approval; code writes remain paused until resolved (/feat-flow-approve).`,
		].join("\n");
	}

	if (view.phase === "alignment") {
		if (gateKind === "plan-approval") {
			return [
				`[feat-flow · Plan Gate Pending · ${view.runId}]`,
				"Plan candidate is submitted and awaiting human approval. Writes stay CLOSED.",
				"Summarize scope, tier, Security/Performance review flags, and slices in <=6 lines, then STOP and ask the user to approve via the prompt (or /feat-flow-approve).",
				...(view.techDesignHtmlPath ? [`HTML alignment doc generated at: ${view.techDesignHtmlPath}`] : []),
			].join("\n");
		}
		const open = view.grilling?.open ?? ["goals", "non-goals", "business-boundary", "error-path", "acceptance"];
		return [
			`[feat-flow · Align Stage · ${view.runId} · ctx ${pct}]`,
			...(view.initialTask ? [`Requirement goal: ${view.initialTask}`] : []),
			"Writes are CLOSED. Use read-only tools (and read-only `scout` subagents for broad codebase/research discovery — do not write research markdown files during alignment).",
			`Method reference (read on demand, private pack): ${methodFile("grilling")} and ${methodFile("domain-modeling")}.`,
			`Open boundaries (${open.length}): ${open.join(", ") || "none"}.`,
			`Ask focused \`ask\` rounds with recommendations without re-asking decided items. Record settled GLOSSARY/ADR updates via ${STEERING_INTENT_HINTS.knowledge}.`,
			`Once boundaries resolve (for small fixes, you can also submit concisely in one step), call ${STEERING_INTENT_HINTS.alignFastOrFull} — do not write temp JSON files.`,
		].join("\n");
	}

	if (view.phase === "implementation") {
		if (gateKind === "checkpoint-review") {
			return [
				`[feat-flow · Mid-Checkpoint Pending · ${view.runId}]`,
				`Paused after slice ${view.pendingGate?.afterSliceId ?? ""}. Writes stay CLOSED until the user approves continuing (/feat-flow-approve) or requests amending remaining slices.`,
				`If amending remaining slices, preserve all completed slices verbatim and submit ${STEERING_INTENT_HINTS.amendPlan}.`,
			].join("\n");
		}
		if (gateKind === "amendment-approval") {
			return [
				`[feat-flow · Plan Amendment Pending · ${view.runId}]`,
				"Amended plan is awaiting human approval (/feat-flow-approve). Summarize the delta and STOP.",
			].join("\n");
		}
		if (gateKind === "delivery") {
			return [
				`[feat-flow · Delivery Gate Pending · ${view.runId}]`,
				"All slices are complete. Summarize changes + verified test output and STOP so the user can trigger Delivery Gate (or /feat-flow-finish).",
			].join("\n");
		}
		const nextSlice = activeSlice(view);
		return [
			`[feat-flow · Implement Stage · ${view.runId} · ctx ${pct}]`,
			`Autonomous serial TDD loop (read ${methodFile("tdd")} and ${methodFile("tdd", "tests.md")}). Read-only \`scout\` subagents remain allowed for cross-module reads to keep main context lean.`,
			nextSlice
				? `Active slice ${nextSlice.id}: ${nextSlice.behavior} | Required test: ${nextSlice.test}`
				: `All slices appear done — verify clean tree + run final checks, then call ${STEERING_INTENT_HINTS.readyForDelivery}.`,
			`After each slice passes tests and is committed cleanly (\`git commit\`), call ${STEERING_INTENT_HINTS.sliceUpdate} and immediately advance to the next slice without stopping to ask.`,
			`If a mid-flight discovery forces re-slicing remaining work, submit ${STEERING_INTENT_HINTS.amendPlan} (preserving completed slices verbatim).`,
			"Workflow guard: do NOT run `git push` or `gh pr` in bash — delivery runs exclusively via Delivery Gate (/feat-flow-finish).",
		].join("\n");
	}

	return `[feat-flow · ${view.phase} · ${view.runId} · ctx ${pct}] Follow host delivery/retro prompts.`;
}
