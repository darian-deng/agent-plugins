/**
 * Shared canonical descriptor for `feat_flow_request` intents and field names.
 * Consumed by both tool registration (`src/index.ts`) and stage prompts (`src/steering.ts`)
 * so prompt/schema drift is unrepresentable.
 */
export const REQUEST_INTENT_KEYS = [
	"boundaries",
	"plan",
	"knowledge",
	"sliceUpdate",
	"checkpoint",
	"readyForDelivery",
] as const;

export type RequestIntentKey = typeof REQUEST_INTENT_KEYS[number];

export const REQUEST_PLAN_FIELDS = {
	proposalScope: "proposalScope",
	summary: "summary",
	slices: "slices",
	signals: "signals",
	declaredFiles: "declaredFiles",
	alignmentDoc: "alignmentDoc",
} as const;

export function countProvidedIntents(params: Partial<Record<RequestIntentKey, unknown>>): RequestIntentKey[] {
	return REQUEST_INTENT_KEYS.filter(key => params[key] !== undefined);
}

export function isAllowedIntentCombination(keys: readonly RequestIntentKey[]): boolean {
	if (keys.length === 1) return true;
	// Small-tier fast path (and clean single-round alignment) permits submitting boundaries + plan atomically.
	return keys.length === 2 && keys.includes("boundaries") && keys.includes("plan");
}

export const STEERING_INTENT_HINTS = {
	knowledge: `\`feat_flow_request({ knowledgePath, knowledgeReason, knowledgeProposed })\``,
	alignFastOrFull:
		`\`feat_flow_request\` (either \`${REQUEST_INTENT_KEYS[0]}\` then \`${REQUEST_INTENT_KEYS[1]}\`, or both together in one call with \`${REQUEST_INTENT_KEYS[1]}: { activities, ${REQUEST_PLAN_FIELDS.slices}, invariant }\`, \`${REQUEST_PLAN_FIELDS.proposalScope}\`, \`${REQUEST_PLAN_FIELDS.summary}\`, \`${REQUEST_PLAN_FIELDS.signals}\`, \`${REQUEST_PLAN_FIELDS.declaredFiles}\`, and \`${REQUEST_PLAN_FIELDS.alignmentDoc}\`)`,
	amendPlan:
		`\`feat_flow_request({ amendPlan: true, ${REQUEST_INTENT_KEYS[1]}, ${REQUEST_PLAN_FIELDS.proposalScope}, ${REQUEST_PLAN_FIELDS.summary}, ${REQUEST_PLAN_FIELDS.signals}, ${REQUEST_PLAN_FIELDS.declaredFiles}, ${REQUEST_PLAN_FIELDS.alignmentDoc} })\``,
	sliceUpdate: `\`feat_flow_request({ ${REQUEST_INTENT_KEYS[3]} })\``,
	checkpoint: `\`feat_flow_request({ ${REQUEST_INTENT_KEYS[4]} })\``,
	readyForDelivery: `\`feat_flow_request({ ${REQUEST_INTENT_KEYS[5]}: true })\``,
} as const;
