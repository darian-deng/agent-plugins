// ─── Hook Input Types ──────────────────────────────────────────────────────────

export interface BaseHookInput {
  session_id: string;
  cwd: string;
}

export interface UserPromptInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface PostToolInput extends BaseHookInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result: unknown;
}

export interface PreToolInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface SessionStartInput extends BaseHookInput {
  hook_event_name: 'SessionStart';
  model?: string;
}

export interface PreCompactInput extends BaseHookInput {
  hook_event_name: 'PreCompact';
}

// ─── Hook Output Types ─────────────────────────────────────────────────────────

export interface PreToolOutput {
  hookEventName: 'PreToolUse';
  permissionDecision: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
}

export interface PostToolOutput {
  hookEventName: 'PostToolUse';
  additionalContext?: string;
}

export interface UserPromptOutput {
  hookEventName: 'UserPromptSubmit';
  permissionDecision?: 'allow' | 'deny';
  permissionDecisionReason?: string;
  additionalContext?: string;
}

export interface SessionOutput {
  hookEventName: 'SessionStart';
  additionalContext?: string;
}

export interface PreCompactOutput {
  hookEventName: 'PreCompact';
}

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?:
    | PreToolOutput
    | PostToolOutput
    | UserPromptOutput
    | SessionOutput
    | PreCompactOutput;
}

// ─── State Types ───────────────────────────────────────────────────────────────

export type StageId =
  | 'stage-1' | 'stage-2' | 'stage-3' | 'stage-4'
  | 'stage-5' | 'stage-6' | 'stage-7' | 'stage-8'
  | 'completed';

export type GateType = 'stage' | 'task';

export interface StageProgress {
  entered_at: string;
  completed_at: string | null;
  gate_approved_at: string | null;
}

export interface ContextWarning {
  warned: boolean;
  warned_at_pct: number | null;
  warned_at: string | null;
}

export interface FeatFlowState {
  _note: string;
  schema_version: string;
  flow_id: string;
  requirement: string;
  current_stage: StageId;
  base_sha: string;
  started_at: string;
  last_session_id: string | null;
  context_size: number;
  stage_progress: Partial<Record<StageId, StageProgress>>;
  waiting_for_gate: boolean;
  gate_type: GateType | null;
  gate_context: string | null;
  expected_next: string;
  context_warning: ContextWarning;
  approved_task_gates: string[];
}

export interface ActiveMarker {
  flow_id: string;
  started_at: string;
}

export interface InitRecord {
  initialized_at: string;
  node_version: string;
  git_remote: string;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

export type CommandResult =
  | { action: 'deny'; reason: string }
  | { action: 'allow'; additionalContext?: string; systemMessage?: string };

export const NEXT_STAGE: Partial<Record<StageId, StageId>> = {
  'stage-1': 'stage-2',
  'stage-2': 'stage-3',
  'stage-3': 'stage-4',
  'stage-4': 'stage-5',
  'stage-5': 'stage-6',
  'stage-6': 'stage-7',
  'stage-7': 'stage-8',
  'stage-8': 'completed',
};

export const STATE_NOTE =
  '此文件由 feat-flow 控制系统自动管理。' +
  '请勿手动修改。如需查看当前状态，请运行 feat-flow status。';
