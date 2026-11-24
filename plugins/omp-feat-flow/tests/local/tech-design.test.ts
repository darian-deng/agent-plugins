import { expect, test } from "bun:test";
import { deriveRequirementProfile, type AlignmentDocument } from "../../src/profile";
import { buildAlignmentReadModel, renderTechDesignHtml } from "../../src/tech-design";

const baseDoc: AlignmentDocument = {
	tldr: "Add token-bucket rate limiter to webhook handler with explicit 429 retry-after headers.",
	problem: "Burst traffic currently saturates downstream queue workers without backpressure.",
	goals: ["Reject requests exceeding 100 req/min per workspace with HTTP 429."],
	nonGoals: ["Do not add distributed Redis coordination in this change."],
	placement: {
		summary: "Sits inside webhook ingress middleware before queue enqueue.",
		upstreamDownstream: ["API Gateway -> WebhookMiddleware -> JobQueue"],
		constraints: ["Must remain single-process in-memory per worker."],
		nodes: [
			{ id: "gw", label: "Gateway", kind: "external" },
			{ id: "rl", label: "RateLimiter", kind: "focal" },
			{ id: "q", label: "JobQueue", kind: "module" },
		],
		edges: [
			{ from: "gw", to: "rl", label: "POST /webhook" },
			{ from: "rl", to: "q", label: "enqueue" },
		],
	},
	mechanism: {
		overview: "Fixed-window counter keyed by workspaceId.",
		contracts: ["checkLimit(workspaceId): { allowed: boolean; retryAfterSec: number }"],
		failureModes: ["Missing workspace header -> 400 Bad Request; never falls back to shared bucket."],
		persistenceOrMigration: "No persistence or migration change.",
	},
	changeSurface: [
		{ path: "src/webhook/limiter.ts", action: "add", summary: "Token bucket limiter class" },
		{ path: "src/webhook/handler.ts", action: "modify", summary: "Invoke checkLimit before enqueue" },
	],
	decisions: [
		{
			decision: "In-memory counter vs Redis",
			choice: "In-memory map per worker",
			rejected: "Redis sorted set",
			rationale: "Single-instance desktop/worker deployment needs zero new ops dependency.",
			impact: "src/webhook/limiter.ts",
		},
	],
	risksAndAssumptions: ["Assumes single-instance webhook receiver per tenant deployment."],
	verification: "bun test tests/webhook/limiter.test.ts",
};

test("deriveRequirementProfile classifies small, medium, and large tiers and security/performance triggers", () => {
	const small = deriveRequirementProfile({
		signals: { expectedFiles: 2, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
		overrides: { autoDeliver: true },
	});
	expect(small.tier).toBe("small");
	expect(small.reviews.security.enabled).toBe(false);
	expect(small.reviews.performance.enabled).toBe(false);
	const smallWithDeclared = deriveRequirementProfile({
		signals: { expectedFiles: 2, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
		declaredFiles: ["src/a.ts"],
		overrides: { autoDeliver: true },
	});
	expect(smallWithDeclared.tier).toBe("small");
	expect(smallWithDeclared.reviews.security.enabled).toBe(false);
	expect(smallWithDeclared.reviews.performance.enabled).toBe(false);
	expect(smallWithDeclared.autoDeliver).toBe(true);

	// Small tier without explicit declaredFiles must NOT autoDeliver.
	const smallNoDeclared = deriveRequirementProfile({
		signals: { expectedFiles: 2, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
		overrides: { autoDeliver: true },
	});
	expect(smallNoDeclared.autoDeliver).toBe(false);

	const medium = deriveRequirementProfile({
		signals: { expectedFiles: 4, distinctModules: 2, riskFlags: ["untrusted-input"], externalEffects: false, estimatedSlices: 2 },
		declaredFiles: ["src/a.ts", "src/b.ts"],
		overrides: { autoDeliver: true },
	});
	expect(medium.tier).toBe("medium");
	expect(medium.reviews.security.enabled).toBe(true);
	expect(medium.reviews.security.triggers).toEqual(["untrusted-input"]);
	expect(medium.reviews.performance.enabled).toBe(false);
	expect(medium.autoDeliver).toBe(false);
	// Hot-path + ipc -> large with both security and performance reviews.
	const large = deriveRequirementProfile({
		signals: { expectedFiles: 6, distinctModules: 3, riskFlags: ["ipc", "hot-path"], externalEffects: true, estimatedSlices: 4 },
	});
	expect(large.tier).toBe("large");
	expect(large.reviews.security.enabled).toBe(true);
	expect(large.reviews.performance.enabled).toBe(true);
});

test("renderTechDesignHtml produces offline self-contained HTML with workflow map, review badges, and canonical read model", () => {
	const profile = deriveRequirementProfile({
		signals: { expectedFiles: 2, distinctModules: 1, riskFlags: ["untrusted-input"], externalEffects: false, estimatedSlices: 2 },
	});
	const meta = {
		runId: "desk-777",
		candidateRevision: 2,
		baseSha: "abc1234",
		linearMode: "required" as const,
		issue: null,
		slices: [
			{ id: "s1", behavior: "Add limiter", test: "limiter.test.ts", dependsOn: [] },
			{ id: "s2", behavior: "Wire handler", test: "handler.test.ts", dependsOn: ["s1"] },
		],
	};

	const readModel = buildAlignmentReadModel(baseDoc, profile, meta);
	expect(readModel.digest).toMatch(/^[a-f0-9]{64}$/);
	expect(readModel.coreSections.map(s => s.sectionId)).toEqual(
		expect.arrayContaining(["tldr", "workflow", "goals", "placement", "mechanism", "change-surface", "verification"]),
	);
	expect(readModel.coreText).toContain("Security review: ON");
	expect(readModel.coreText).toContain("Performance review: OFF");

	const html = renderTechDesignHtml(baseDoc, profile, meta);
	expect(html).toContain("<!doctype html>");
	expect(html).not.toMatch(/https?:\/\/cdn/i);
	expect(html).not.toContain("<script src=");
	expect(html).toContain("desk-777");
	expect(html).toContain("Security Review: ON");
	expect(html).toContain("Performance Review: OFF");
	expect(html).toContain("Gate 1: Plan Approve");
	expect(html).toContain("src/webhook/limiter.ts");
	expect(html).toContain("<svg");
});
