import { z } from "zod";

export const RISK_FLAGS = [
	"auth",
	"crypto",
	"secrets",
	"untrusted-input",
	"network-protocol",
	"ipc",
	"db-schema",
	"data-migration",
	"payment",
	"lockfile-change",
	"permissions",
	"hot-path",
	"memory-sensitive",
] as const;

export const riskFlagSchema = z.enum(RISK_FLAGS);
export type RiskFlag = z.infer<typeof riskFlagSchema>;

export const SECURITY_TRIGGER_FLAGS = new Set<RiskFlag>([
	"auth",
	"crypto",
	"secrets",
	"untrusted-input",
	"network-protocol",
	"ipc",
	"db-schema",
	"data-migration",
	"payment",
	"lockfile-change",
	"permissions",
]);

export const PERFORMANCE_TRIGGER_FLAGS = new Set<RiskFlag>([
	"hot-path",
	"memory-sensitive",
	"data-migration",
]);

export const requirementSignalsSchema = z.object({
	expectedFiles: z.number().int().min(1).max(500),
	distinctModules: z.number().int().min(1).max(100),
	riskFlags: z.array(riskFlagSchema).max(RISK_FLAGS.length),
	externalEffects: z.boolean(),
	estimatedSlices: z.number().int().min(1).max(64),
}).strict();
export type RequirementSignals = z.infer<typeof requirementSignalsSchema>;

export const reviewPolicySchema = z.object({
	enabled: z.boolean(),
	triggers: z.array(riskFlagSchema),
	reason: z.string().min(1),
	overridden: z.boolean().default(false),
}).strict();
export type ReviewPolicy = z.infer<typeof reviewPolicySchema>;

export const requirementProfileSchema = z.object({
	tier: z.enum(["small", "medium", "large"]),
	tierSource: z.enum(["derived", "user-override"]),
	signals: requirementSignalsSchema,
	reviews: z.object({
		security: reviewPolicySchema,
		performance: reviewPolicySchema,
	}).strict(),
	autoDeliver: z.boolean().default(false),
	declaredFiles: z.array(z.string().min(1)).max(256).default([]),
}).strict();
export type RequirementProfile = z.infer<typeof requirementProfileSchema>;

export function deriveRequirementProfile(input: {
	signals: RequirementSignals;
	actualSlices?: number;
	declaredFiles?: string[];
	overrides?: {
		tier?: "small" | "medium" | "large";
		security?: { enabled: boolean; reason: string };
		performance?: { enabled: boolean; reason: string };
		autoDeliver?: boolean;
	};
}): RequirementProfile {
	const signals = requirementSignalsSchema.parse(input.signals);
	const flags = [...new Set(signals.riskFlags)];
	const effectiveSlices = Math.max(signals.estimatedSlices, input.actualSlices ?? signals.estimatedSlices);
	const highImpact = flags.some(f => f === "db-schema" || f === "data-migration" || f === "payment");
	const derivedTier: "small" | "medium" | "large" =
		signals.expectedFiles <= 3 && flags.length === 0 && effectiveSlices <= 1
			? "small"
			: signals.expectedFiles <= 10 && flags.length <= 1 && effectiveSlices <= 3 && !highImpact
				? "medium"
				: "large";
	const tier = input.overrides?.tier ?? derivedTier;
	const secTriggers = flags.filter(f => SECURITY_TRIGGER_FLAGS.has(f));
	const perfTriggers = flags.filter(f => PERFORMANCE_TRIGGER_FLAGS.has(f));
	const security: ReviewPolicy = input.overrides?.security !== undefined
		? {
			enabled: input.overrides.security.enabled,
			triggers: secTriggers,
			reason: input.overrides.security.reason,
			overridden: true,
		}
		: {
			enabled: secTriggers.length > 0,
			triggers: secTriggers,
			reason: secTriggers.length > 0
				? `Triggered by risk flag(s): ${secTriggers.join(", ")}`
				: "No security risk flags present (auth/crypto/secrets/untrusted-input/ipc/schema/permissions/lockfile)",
			overridden: false,
		};
	const performance: ReviewPolicy = input.overrides?.performance !== undefined
		? {
			enabled: input.overrides.performance.enabled,
			triggers: perfTriggers,
			reason: input.overrides.performance.reason,
			overridden: true,
		}
		: {
			enabled: perfTriggers.length > 0,
			triggers: perfTriggers,
			reason: perfTriggers.length > 0
				? `Triggered by risk flag(s): ${perfTriggers.join(", ")}`
				: "No performance risk flags present (hot-path/memory-sensitive/data-migration)",
			overridden: false,
		};
	// Only small tier with explicit declaredFiles may opt in to bounded auto-deliver.
	const declaredFiles = input.declaredFiles ?? [];
	const autoDeliver = tier === "small" && declaredFiles.length > 0 ? Boolean(input.overrides?.autoDeliver) : false;
	return {
		tier,
		tierSource: input.overrides?.tier ? "user-override" : "derived",
		signals: { ...signals, riskFlags: flags },
		reviews: { security, performance },
		autoDeliver,
		declaredFiles,
	};
}

export function applyGate1Overrides(
	profile: RequirementProfile,
	override: { securityEnabled?: boolean; performanceEnabled?: boolean; autoDeliver?: boolean },
): RequirementProfile {
	const security: ReviewPolicy = override.securityEnabled !== undefined && override.securityEnabled !== profile.reviews.security.enabled
		? {
			...profile.reviews.security,
			enabled: override.securityEnabled,
			reason: override.securityEnabled ? "Enabled by human at Gate 1" : "Waived by human at Gate 1",
			overridden: true,
		}
		: profile.reviews.security;
	const performance: ReviewPolicy = override.performanceEnabled !== undefined && override.performanceEnabled !== profile.reviews.performance.enabled
		? {
			...profile.reviews.performance,
			enabled: override.performanceEnabled,
			reason: override.performanceEnabled ? "Enabled by human at Gate 1" : "Waived by human at Gate 1",
			overridden: true,
		}
		: profile.reviews.performance;
	const autoDeliver = override.autoDeliver !== undefined
		? (profile.tier === "small" && profile.declaredFiles.length > 0 ? override.autoDeliver : false)
		: profile.autoDeliver;
	return {
		...profile,
		reviews: { security, performance },
		autoDeliver,
	};
}

export function preserveAmendedReviewOverrides(
	previous: RequirementProfile | null | undefined,
	next: RequirementProfile,
): RequirementProfile {
	if (!previous) return next;
	const security = previous.reviews.security.overridden && previous.reviews.security.enabled && !next.reviews.security.enabled
		? { ...next.reviews.security, enabled: true, reason: `${previous.reviews.security.reason} (preserved across amendment)`, overridden: true }
		: next.reviews.security;
	const performance = previous.reviews.performance.overridden && previous.reviews.performance.enabled && !next.reviews.performance.enabled
		? { ...next.reviews.performance, enabled: true, reason: `${previous.reviews.performance.reason} (preserved across amendment)`, overridden: true }
		: next.reviews.performance;
	return { ...next, reviews: { security, performance } };
}

export const diagramNodeSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	kind: z.enum(["module", "external", "store", "boundary", "focal"]).default("module"),
}).strict();

export const diagramEdgeSchema = z.object({
	from: z.string().min(1),
	to: z.string().min(1),
	label: z.string().default(""),
}).strict();

export const alignmentChangeSurfaceRowSchema = z.object({
	path: z.string().min(1),
	action: z.enum(["add", "modify", "delete"]),
	summary: z.string().min(1),
}).strict();

export const alignmentDecisionRowSchema = z.object({
	decision: z.string().min(1),
	choice: z.string().min(1),
	rejected: z.string().min(1),
	rationale: z.string().min(1),
	impact: z.string().min(1),
}).strict();

export const alignmentDocumentSchema = z.object({
	tldr: z.string().min(1),
	problem: z.string().min(1),
	goals: z.array(z.string().min(1)).min(1),
	nonGoals: z.array(z.string().min(1)).min(1),
	placement: z.object({
		summary: z.string().min(1),
		upstreamDownstream: z.array(z.string().min(1)).default([]),
		constraints: z.array(z.string().min(1)).default([]),
		nodes: z.array(diagramNodeSchema).default([]),
		edges: z.array(diagramEdgeSchema).default([]),
	}).strict(),
	mechanism: z.object({
		overview: z.string().min(1),
		contracts: z.array(z.string().min(1)).default([]),
		failureModes: z.array(z.string().min(1)).default([]),
		persistenceOrMigration: z.string().default("No persistence or migration change."),
	}).strict(),
	changeSurface: z.array(alignmentChangeSurfaceRowSchema).min(1),
	decisions: z.array(alignmentDecisionRowSchema).default([]),
	risksAndAssumptions: z.array(z.string().min(1)).default([]),
	verification: z.string().min(1),
}).strict();
export type AlignmentDocument = z.infer<typeof alignmentDocumentSchema>;
