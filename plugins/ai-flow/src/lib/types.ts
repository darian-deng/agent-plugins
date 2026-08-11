// ─── Hook Input Types ──────────────────────────────────────────────────────────

export interface BaseHookInput {
  session_id: string;
  cwd: string;
  transcript_path?: string;
  permission_mode?: string;
  /**
   * Populated only when the hook fires inside a subagent; a subagent shares its
   * parent's session_id, so this is the only way to tell the two apart. Optional
   * on purpose — clients that don't send it must keep behaving as before, so
   * every consumer has to branch on presence, never on a value.
   */
  agent_id?: string;
  agent_type?: string;
}

export interface UserPromptInput extends BaseHookInput {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface PostToolInput extends BaseHookInput {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id?: string;
  duration_ms?: number;
}

export interface PreToolInput extends BaseHookInput {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface SessionStartInput extends BaseHookInput {
  hook_event_name: 'SessionStart';
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  model?: string;
}

export interface SessionEndInput extends BaseHookInput {
  hook_event_name: 'SessionEnd';
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

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?:
    | PreToolOutput
    | PostToolOutput
    | UserPromptOutput
    | SessionOutput;
}

// ─── Command Result ─────────────────────────────────────────────────────────────

export type CommandResult =
  | { action: 'deny'; reason: string }
  | { action: 'allow'; additionalContext?: string; systemMessage?: string };
