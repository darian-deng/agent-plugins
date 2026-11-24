import { sha256Hex } from "./config";
import type { PlanSlice } from "./plan";
import type { AlignmentDocument, RequirementProfile } from "./profile";

export interface AlignmentMeta {
	runId: string;
	candidateRevision: number;
	baseSha: string;
	linearMode: "required" | "optional" | "disabled";
	issue: string | null;
	slices: PlanSlice[];
	midCheckpointAfterSliceId?: string | null;
	isAmendment?: boolean;
}
export interface ReadModelSection {
	sectionId: string;
	title: string;
	disclosure: "core" | "appendix";
	text: string;
}

export interface AlignmentReadModel {
	digest: string;
	coreSections: ReadModelSection[];
	appendixSections: ReadModelSection[];
	coreText: string;
	fullText: string;
	workflowSteps: Array<{
		id: string;
		label: string;
		kind: "auto" | "gate" | "review" | "optional";
		detail: string;
	}>;
}

function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function buildWorkflowSteps(profile: RequirementProfile, meta: AlignmentMeta): AlignmentReadModel["workflowSteps"] {
	const linearDesc = meta.linearMode === "disabled"
		? "GitHub PR only (Linear disabled)"
		: meta.issue
			? `Bound to ${meta.issue}`
			: meta.linearMode === "required"
				? "Create/Bind Linear issue required at Plan Gate"
				: "Optional Linear issue at Plan Gate";
	const steps: AlignmentReadModel["workflowSteps"] = [
		{ id: "align", label: meta.isAmendment ? "Amend Remaining Plan" : "Align Boundaries", kind: "auto", detail: `Tier ${profile.tier.toUpperCase()} (${profile.tierSource}) · ${meta.slices.length} slice(s)` },
		{
			id: "plan-gate",
			label: meta.isAmendment ? "Gate: Amendment Approve" : (profile.autoDeliver ? "Gate 1: Plan Approve (+ Auto-Deliver)" : "Gate 1: Plan Approve"),
			kind: "gate",
			detail: linearDesc,
		},
		{ id: "implement", label: `Implement (${meta.slices.length} serial slices)`, kind: "auto", detail: "TDD red -> green -> host-verified slice commit" },
	];
	if (meta.midCheckpointAfterSliceId) {
		steps.push({
			id: "mid-checkpoint",
			label: `Mid-Checkpoint (after ${meta.midCheckpointAfterSliceId})`,
			kind: "gate",
			detail: "Human progress review before continuing remaining slices",
		});
	}
	if (profile.reviews.security.enabled) {
		steps.push({ id: "sec-review", label: "Security Review: ON", kind: "review", detail: profile.reviews.security.reason });
	} else {
		steps.push({ id: "sec-review", label: "Security Review: OFF", kind: "review", detail: profile.reviews.security.reason });
	}
	if (profile.reviews.performance.enabled) {
		steps.push({ id: "perf-review", label: "Performance Review: ON", kind: "review", detail: profile.reviews.performance.reason });
	} else {
		steps.push({ id: "perf-review", label: "Performance Review: OFF", kind: "review", detail: profile.reviews.performance.reason });
	}
	steps.push({
		id: "delivery-gate",
		label: profile.autoDeliver ? "Delivery (Pre-Authorized if Scope Unchanged)" : "Gate 2: Delivery Approve",
		kind: profile.autoDeliver ? "auto" : "gate",
		detail: "Sync base -> Code review -> Push -> 1 PR -> Linear update",
	});
	steps.push({ id: "retro", label: "Optional Retro & Workspace Close", kind: "optional", detail: "Optional rule distillation after delivery receipt" });
	return steps;
}

export function buildAlignmentReadModel(doc: AlignmentDocument, profile: RequirementProfile, meta: AlignmentMeta): AlignmentReadModel {
	const workflowSteps = buildWorkflowSteps(profile, meta);
	const workflowText = [
		`Tier: ${profile.tier.toUpperCase()} (${profile.tierSource}); Auto-deliver: ${profile.autoDeliver ? "ON" : "OFF"}; Linear: ${meta.linearMode}${meta.issue ? ` (${meta.issue})` : ""}`,
		`Security review: ${profile.reviews.security.enabled ? "ON" : "OFF"} (${profile.reviews.security.reason})`,
		`Performance review: ${profile.reviews.performance.enabled ? "ON" : "OFF"} (${profile.reviews.performance.reason})`,
		...workflowSteps.map(s => `- [${s.kind.toUpperCase()}] ${s.label}: ${s.detail}`),
	].join("\n");

	const placementEdges = doc.placement.edges.map(e => `${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ""}`);
	const placementNodes = doc.placement.nodes.map(n => `${n.id} [${n.kind}]: ${n.label}`);

	const coreSections: ReadModelSection[] = [
		{ sectionId: "tldr", title: "30-Second Alignment", disclosure: "core", text: `${doc.tldr}\nProblem: ${doc.problem}` },
		{ sectionId: "workflow", title: "This Run's Workflow Map", disclosure: "core", text: workflowText },
		{
			sectionId: "goals",
			title: "Goals & Non-Goals",
			disclosure: "core",
			text: `Goals:\n${doc.goals.map(g => `- ${g}`).join("\n")}\nNon-Goals:\n${doc.nonGoals.map(n => `- ${n}`).join("\n")}`,
		},
		{
			sectionId: "placement",
			title: "Current Placement & Constraints",
			disclosure: "core",
			text: [
				doc.placement.summary,
				...doc.placement.upstreamDownstream.map(s => `Flow: ${s}`),
				...doc.placement.constraints.map(c => `Constraint: ${c}`),
				...placementNodes,
				...placementEdges,
			].join("\n"),
		},
		{
			sectionId: "mechanism",
			title: "Mechanism & Failure Contracts",
			disclosure: "core",
			text: [
				doc.mechanism.overview,
				...doc.mechanism.contracts.map(c => `Contract: ${c}`),
				...doc.mechanism.failureModes.map(f => `Failure: ${f}`),
				`Persistence/Migration: ${doc.mechanism.persistenceOrMigration}`,
			].join("\n"),
		},
		{
			sectionId: "change-surface",
			title: "Codebase Change Surface",
			disclosure: "core",
			text: doc.changeSurface.map(r => `- [${r.action}] ${r.path}: ${r.summary}`).join("\n"),
		},
		{
			sectionId: "verification",
			title: "Verification & Slices",
			disclosure: "core",
			text: `Verification: ${doc.verification}\nSlices:\n${meta.slices.map((s, i) => `${i + 1}. ${s.id}: ${s.behavior} (test: ${s.test})`).join("\n")}`,
		},
	];

	const appendixSections: ReadModelSection[] = [
		{
			sectionId: "decisions",
			title: "Consequential Decision Ledger",
			disclosure: "appendix",
			text: doc.decisions.length > 0
				? doc.decisions.map(d => `- ${d.decision}: chose "${d.choice}" over "${d.rejected}" (${d.rationale}) [impact: ${d.impact}]`).join("\n")
				: "No separate decision ledger entries.",
		},
		{
			sectionId: "risks",
			title: "Risks & Assumptions",
			disclosure: "appendix",
			text: doc.risksAndAssumptions.length > 0 ? doc.risksAndAssumptions.map(r => `- ${r}`).join("\n") : "No extra assumptions recorded.",
		},
	];

	const coreText = coreSections.map(s => `## [${s.sectionId}] ${s.title}\n${s.text}`).join("\n\n");
	const fullText = [...coreSections, ...appendixSections].map(s => `## [${s.sectionId}] ${s.title}\n${s.text}`).join("\n\n");
	return {
		digest: sha256Hex(fullText),
		coreSections,
		appendixSections,
		coreText,
		fullText,
		workflowSteps,
	};
}

function wrapSvgLabel(text: string, maxChars: number): [string, string | null] {
	if (text.length <= maxChars) return [text, null];
	const splitAt = text.lastIndexOf(" ", maxChars);
	const idx = splitAt >= Math.floor(maxChars * 0.45) ? splitAt : maxChars;
	const line1 = text.slice(0, idx).trim();
	const rest = text.slice(idx).trim();
	const line2 = rest.length > maxChars ? `${rest.slice(0, maxChars - 1)}…` : rest;
	return [line1, line2 || null];
}

function renderWorkflowSvg(steps: AlignmentReadModel["workflowSteps"]): string {
	const boxW = 212;
	const boxH = 72;
	const gap = 22;
	const pad = 12;
	const width = steps.length * boxW + Math.max(0, steps.length - 1) * gap + pad * 2;
	const height = boxH + pad * 2 + 12;
	const parts: string[] = [
		`<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:${Math.min(width, 720)}px" role="img" aria-label="Requirement Workflow Map">`,
	];
	steps.forEach((step, idx) => {
		const x = pad + idx * (boxW + gap);
		const y = pad;
		const badge = step.kind === "gate" ? "HUMAN GATE" : step.kind === "review" ? "INDEPENDENT" : step.kind === "optional" ? "OPTIONAL" : "AUTO";
		const stroke = step.kind === "gate" ? "#d97706" : step.kind === "review" && step.label.includes(": ON") ? "#2563eb" : "#64748b";
		const fill = step.kind === "gate" ? "rgba(217,119,6,0.12)" : step.kind === "review" && step.label.includes(": ON") ? "rgba(37,99,235,0.10)" : "rgba(100,116,139,0.08)";
		const [line1, line2] = wrapSvgLabel(step.label, 24);
		parts.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
		parts.push(`<text x="${x + 10}" y="${y + 18}" font-size="10" font-weight="700" fill="${stroke}">${escapeHtml(badge)}</text>`);
		parts.push(`<text x="${x + 10}" y="${y + 38}" font-size="12" font-weight="600" fill="currentColor">${escapeHtml(line1)}</text>`);
		if (line2) {
			parts.push(`<text x="${x + 10}" y="${y + 54}" font-size="12" font-weight="600" fill="currentColor">${escapeHtml(line2)}</text>`);
		}
		if (idx < steps.length - 1) {
			const x1 = x + boxW;
			const x2 = x1 + gap;
			const cy = y + boxH / 2;
			parts.push(`<line x1="${x1}" y1="${cy}" x2="${x2 - 4}" y2="${cy}" stroke="#94a3b8" stroke-width="1.5"/>`);
			parts.push(`<polygon points="${x2 - 5},${cy - 4} ${x2},${cy} ${x2 - 5},${cy + 4}" fill="#94a3b8"/>`);
		}
	});
	parts.push("</svg>");
	return parts.join("");
}

function renderPlacementSvg(doc: AlignmentDocument): string {
	const nodes = doc.placement.nodes;
	if (nodes.length === 0) return "";
	const boxW = 168;
	const boxH = 52;
	const gap = 42;
	const pad = 16;
	const topArcSpace = 34;
	const bottomArcSpace = 34;
	const width = nodes.length * boxW + Math.max(0, nodes.length - 1) * gap + pad * 2;
	const height = boxH + pad * 2 + topArcSpace + bottomArcSpace;
	const baseY = pad + topArcSpace;
	const parts: string[] = [
		`<svg viewBox="0 0 ${width} ${height}" width="100%" style="min-width:${Math.min(width, 640)}px" role="img" aria-label="Architecture Placement">`,
		`<defs><marker id="ff-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 1 L 10 5 L 0 9 z" fill="#94a3b8"/></marker></defs>`,
	];
	const positions = new Map<string, { idx: number; x: number; y: number }>();
	nodes.forEach((node, idx) => {
		const x = pad + idx * (boxW + gap);
		const y = baseY;
		positions.set(node.id, { idx, x, y });
		const isFocal = node.kind === "focal";
		const stroke = isFocal ? "#ea580c" : "#64748b";
		const fill = isFocal ? "rgba(234,88,12,0.12)" : "rgba(100,116,139,0.08)";
		const [line1, line2] = wrapSvgLabel(node.label, 19);
		parts.push(`<rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
		if (line2) {
			parts.push(`<text x="${x + boxW / 2}" y="${y + 22}" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">${escapeHtml(line1)}</text>`);
			parts.push(`<text x="${x + boxW / 2}" y="${y + 38}" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">${escapeHtml(line2)}</text>`);
		} else {
			parts.push(`<text x="${x + boxW / 2}" y="${y + 30}" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">${escapeHtml(line1)}</text>`);
		}
	});
	for (const edge of doc.placement.edges) {
		const a = positions.get(edge.from);
		const b = positions.get(edge.to);
		if (!a || !b) continue;
		const delta = b.idx - a.idx;
		if (delta === 1) {
			const x1 = a.x + boxW;
			const x2 = b.x;
			const cy = a.y + boxH / 2;
			parts.push(`<line x1="${x1}" y1="${cy}" x2="${x2 - 2}" y2="${cy}" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ff-arrow)"/>`);
			if (edge.label) {
				parts.push(`<text x="${(x1 + x2) / 2}" y="${cy - 7}" text-anchor="middle" font-size="10" fill="#64748b">${escapeHtml(edge.label.slice(0, 18))}</text>`);
			}
		} else {
			// Route non-adjacent or backward edges cleanly above/below boxes to avoid crossing through intermediate nodes.
			const above = delta > 1;
			const x1 = a.x + boxW / 2;
			const x2 = b.x + boxW / 2;
			const yEdge = above ? a.y : a.y + boxH;
			const arcY = above ? a.y - 24 : a.y + boxH + 24;
			const midX = (x1 + x2) / 2;
			parts.push(`<path d="M ${x1} ${yEdge} Q ${midX} ${arcY} ${x2} ${yEdge}" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ff-arrow)"/>`);
			if (edge.label) {
				parts.push(`<text x="${midX}" y="${above ? arcY + 10 : arcY + 4}" text-anchor="middle" font-size="10" fill="#64748b">${escapeHtml(edge.label.slice(0, 22))}</text>`);
			}
		}
	}
	parts.push("</svg>");
	return parts.join("");
}

export function renderTechDesignHtml(doc: AlignmentDocument, profile: RequirementProfile, meta: AlignmentMeta): string {
	const readModel = buildAlignmentReadModel(doc, profile, meta);
	const workflowSvg = renderWorkflowSvg(readModel.workflowSteps);
	const placementSvg = renderPlacementSvg(doc);
	const actionsPresent = new Set(doc.changeSurface.map(r => r.action));
	const missingActions = (["add", "modify", "delete"] as const).filter(a => !actionsPresent.has(a));

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.runId)} · Technical Alignment (r${meta.candidateRevision})</title>
<style>
:root { --bg: #f8fafc; --card: #ffffff; --fg: #0f172a; --muted: #475569; --border: #e2e8f0; --accent: #2563eb; --warn: #d97706; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --card: #111827; --fg: #e2e8f0; --muted: #94a3b8; --border: #1e293b; --accent: #60a5fa; --warn: #fbbf24; } }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); margin: 0; padding: 24px; line-height: 1.6; }
main { max-width: 102ch; margin: 0 auto; }
section { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 22px; margin-bottom: 16px; }
h1 { margin: 0 0 8px; font-size: 1.5rem; }
h2 { margin: 0 0 10px; font-size: 1.15rem; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.badge { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); background: rgba(100,116,139,0.1); }
.badge.on { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.badge.gate { border-color: var(--warn); color: var(--warn); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.muted { color: var(--muted); font-size: 13px; }
.diagram-scroll { overflow-x: auto; padding-bottom: 6px; }
</style>
</head>
<body>
<main>
  <section>
    <h1>${escapeHtml(meta.runId)} · Technical Design Alignment (r${meta.candidateRevision})</h1>
    <div class="badges">
      <span class="badge">Tier: ${escapeHtml(profile.tier.toUpperCase())} (${escapeHtml(profile.tierSource)})</span>
      <span class="badge ${profile.reviews.security.enabled ? "on" : ""}">Security Review: ${profile.reviews.security.enabled ? "ON" : "OFF"}</span>
      <span class="badge ${profile.reviews.performance.enabled ? "on" : ""}">Performance Review: ${profile.reviews.performance.enabled ? "ON" : "OFF"}</span>
      <span class="badge ${profile.autoDeliver ? "gate" : ""}">Auto-Deliver: ${profile.autoDeliver ? "ON (bounded small)" : "OFF (Gate 2 required)"}</span>
      <span class="badge">Linear: ${escapeHtml(meta.linearMode)}${meta.issue ? ` (${escapeHtml(meta.issue)})` : ""}</span>
      <span class="badge">Base: <code>${escapeHtml(meta.baseSha.slice(0, 12))}</code></span>
    </div>
    <p><b>TL;DR:</b> ${escapeHtml(doc.tldr)}</p>
    <p class="muted"><b>Problem:</b> ${escapeHtml(doc.problem)}</p>
  </section>

  <section>
    <h2>1. Workflow Map For This Requirement</h2>
    <div class="diagram-scroll">${workflowSvg}</div>
    <ul>
      ${readModel.workflowSteps.map(s => `<li><b>${escapeHtml(s.label)}</b> <span class="muted">[${escapeHtml(s.kind)}]</span> — ${escapeHtml(s.detail)}</li>`).join("\n      ")}
    </ul>
  </section>

  <section>
    <h2>2. Goals &amp; Non-Goals</h2>
    <p><b>Goals</b></p>
    <ul>${doc.goals.map(g => `<li>${escapeHtml(g)}</li>`).join("")}</ul>
    <p><b>Non-Goals</b></p>
    <ul>${doc.nonGoals.map(n => `<li>${escapeHtml(n)}</li>`).join("")}</ul>
  </section>

  <section>
    <h2>3. Current Architecture Placement &amp; Constraints</h2>
    <p>${escapeHtml(doc.placement.summary)}</p>
    ${placementSvg ? `<div class="diagram-scroll">${placementSvg}</div>` : ""}
    ${doc.placement.constraints.length > 0 ? `<ul>${doc.placement.constraints.map(c => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` : ""}
  </section>

  <section>
    <h2>4. Mechanism &amp; Failure Contracts</h2>
    <p>${escapeHtml(doc.mechanism.overview)}</p>
    ${doc.mechanism.contracts.length > 0 ? `<p><b>Contracts</b></p><ul>${doc.mechanism.contracts.map(c => `<li><code>${escapeHtml(c)}</code></li>`).join("")}</ul>` : ""}
    ${doc.mechanism.failureModes.length > 0 ? `<p><b>Failure Modes</b></p><ul>${doc.mechanism.failureModes.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
    <p class="muted"><b>Persistence / Migration:</b> ${escapeHtml(doc.mechanism.persistenceOrMigration)}</p>
  </section>

  <section>
    <h2>5. Codebase Change Surface</h2>
    <table>
      <tr><th>Action</th><th>Path</th><th>Change</th></tr>
      ${doc.changeSurface.map(r => `<tr><td><code>${escapeHtml(r.action)}</code></td><td><code>${escapeHtml(r.path)}</code></td><td>${escapeHtml(r.summary)}</td></tr>`).join("\n      ")}
      ${missingActions.map(a => `<tr><td><code>${a}</code></td><td class="muted">(none)</td><td class="muted">No ${a} changes planned</td></tr>`).join("\n      ")}
    </table>
  </section>

  <section>
    <h2>6. Verification &amp; Serial Slices (${meta.slices.length})</h2>
    <p><b>Verification:</b> <code>${escapeHtml(doc.verification)}</code></p>
    <table>
      <tr><th>#</th><th>Slice</th><th>Behavior</th><th>Test</th></tr>
      ${meta.slices.map((s, i) => `<tr><td>${i + 1}</td><td><code>${escapeHtml(s.id)}</code>${s.status === "done" ? ` <span class="badge on">DONE</span>` : ""}</td><td>${escapeHtml(s.behavior)}</td><td><code>${escapeHtml(s.test)}</code></td></tr>`).join("\n      ")}
    </table>
  </section>

  <section>
    <h2>7. Decision Ledger &amp; Risks (Appendix)</h2>
    <details>
      <summary>Consequential Decisions (${doc.decisions.length}) &amp; Risks (${doc.risksAndAssumptions.length})</summary>
      ${doc.decisions.length > 0 ? `<table><tr><th>Decision</th><th>Choice</th><th>Rejected</th><th>Rationale</th><th>Impact</th></tr>${doc.decisions.map(d => `<tr><td>${escapeHtml(d.decision)}</td><td>${escapeHtml(d.choice)}</td><td>${escapeHtml(d.rejected)}</td><td>${escapeHtml(d.rationale)}</td><td><code>${escapeHtml(d.impact)}</code></td></tr>`).join("")}</table>` : `<p class="muted">No separate decision ledger rows.</p>`}
      ${doc.risksAndAssumptions.length > 0 ? `<ul>${doc.risksAndAssumptions.map(r => `<li>${escapeHtml(r)}</li>`).join("")}</ul>` : ""}
    </details>
  </section>
</main>
</body>
</html>
`;
}
