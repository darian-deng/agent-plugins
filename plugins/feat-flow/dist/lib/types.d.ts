export interface BaseHookInput {
    session_id: string;
    cwd: string;
    transcript_path?: string;
    permission_mode?: string;
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
    agent_type?: string;
}
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
    hookSpecificOutput?: PreToolOutput | PostToolOutput | UserPromptOutput | SessionOutput;
}
export type CommandResult = {
    action: 'deny';
    reason: string;
} | {
    action: 'allow';
    additionalContext?: string;
    systemMessage?: string;
};
//# sourceMappingURL=types.d.ts.map