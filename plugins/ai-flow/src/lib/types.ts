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
  /**
   * Who authored or injected this prompt. Verified against the 2.1.278 binary, where
   * the schema is `z(["user","sdk","system","loop_wakeup","schedule_wakeup",
   * "poll_event"]).optional()`:
   *   user           interactive composer
   *   sdk            `-p` / Agent SDK entrypoint
   *   loop_wakeup    a `/loop` firing
   *   schedule_wakeup a scheduled task firing — what a watchdog tick arrives as
   * Optional, so a client that omits it must keep working: the watchdog treats a
   * missing value as "unknown" and falls back to matching the prompt text.
   */
  source?: 'user' | 'sdk' | 'system' | 'loop_wakeup' | 'schedule_wakeup' | 'poll_event';
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

/** One in-flight background task as reported in `Stop` input. */
export interface BackgroundTaskEntry {
  id?: string;
  /** `shell` | `subagent` | `monitor` | `workflow` | `teammate` | … */
  type?: string;
  status?: string;
  description?: string;
  /**
   * The shell command line, present only for `shell` tasks and capped at 1000
   * characters by the host. This is how the engine recognises its own stall watcher
   * among the session's background work — the only channel that carries a value the
   * engine itself put there.
   */
  command?: string;
}

/** One session-scoped scheduled wakeup (CronCreate / ScheduleWakeup / /loop). */
export interface SessionCronEntry {
  id?: string;
  schedule?: string;
  recurring?: boolean;
  /** The prompt submitted when it fires — how the watchdog recognises its own cron. */
  prompt?: string;
}

export interface StopInput extends BaseHookInput {
  hook_event_name: 'Stop';
  /**
   * True when this turn only happened because a Stop hook asked for it. Used the
   * way the host documents: bail out, so a hook can never chain continuations.
   */
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  /**
   * Present when the task registry is reachable, empty when nothing is in flight.
   * ABSENT is therefore not the same as empty, and the watchdog must not read a
   * missing array as "nothing is running" — see stop-handler.
   */
  background_tasks?: BackgroundTaskEntry[];
  session_crons?: SessionCronEntry[];
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
  /**
   * Top-level block, the form `UserPromptSubmit` uses to drop a prompt before the
   * model ever sees it: `reason` goes to the developer, nothing goes to the model.
   * The watchdog's suppressed ticks ride this — it is what makes a tick that finds
   * nothing wrong cost zero tokens.
   */
  decision?: 'block';
  reason?: string;
  /** Keeps the blocked prompt's own text out of the message shown to the developer. */
  suppressOriginalPrompt?: boolean;
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
