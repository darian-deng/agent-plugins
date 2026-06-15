import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';

/**
 * session → anchor binding.
 *
 * WHY this exists: every hook only receives (cwd, session_id). The owning flow
 * used to be resolved by walking UP from cwd to the nearest `.ai-flow` dir
 * (hasActiveFlow). That is correct only while cwd stays at-or-below the anchor.
 * Once flows can be anchored in a monorepo sub-project, the agent can `cd` to an
 * ANCESTOR of the anchor — and walk-up then resolves the WRONG flow (or none),
 * because the anchor lives in a subtree the walk-up never visits.
 *
 * The fix is a cwd-INDEPENDENT index keyed only by session_id, living at a fixed
 * location outside any repo. active.json cannot serve this role: to read it you
 * must already know the anchor (its own location) — the very thing cwd-drift
 * destroyed. So we keep one small file per session here.
 *
 * Per-session files (not one big JSON) so that: size stays ≈ concurrent live
 * sessions (GC prunes the dead), a corrupt file only affects its own session,
 * and concurrent sessions never contend on a shared file.
 *
 * This is best-effort: every operation swallows errors. Resolution always falls
 * back to walk-up, so a missing/corrupt registry degrades gracefully rather than
 * breaking a hook.
 */
export interface SessionBinding {
  sessionId: string;
  projectRoot: string;
  flowName: string;
  boundAt: string;
}

function claudeDir(): string {
  // Honor CLAUDE_CONFIG_DIR (Claude Code's config relocation env, also used for
  // test isolation) before falling back to the default ~/.claude.
  return process.env['CLAUDE_CONFIG_DIR'] || join(homedir(), '.claude');
}

function registryDir(): string {
  return join(claudeDir(), 'ai-flow', 'sessions');
}

function bindingPath(sessionId: string): string {
  // session_id is opaque input — sanitize to a safe single-segment filename.
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
  return join(registryDir(), `${safe}.json`);
}

export function bindSession(sessionId: string, projectRoot: string, flowName: string): void {
  try {
    const dir = registryDir();
    mkdirSync(dir, { recursive: true });
    const payload: SessionBinding = {
      sessionId,
      projectRoot,
      flowName,
      boundAt: new Date().toISOString(),
    };
    const tmp = join(dir, `${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, bindingPath(sessionId));
  } catch {
    /* best-effort: resolution falls back to walk-up */
  }
}

export function lookupSession(sessionId: string): SessionBinding | null {
  try {
    const p = bindingPath(sessionId);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as SessionBinding;
    if (
      !parsed ||
      typeof parsed.projectRoot !== 'string' ||
      typeof parsed.flowName !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function unbindSession(sessionId: string): void {
  try {
    const p = bindingPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best-effort */
  }
}

/** All currently-stored bindings. Corrupt/unreadable files are skipped. */
export function listBindings(): SessionBinding[] {
  try {
    const dir = registryDir();
    if (!existsSync(dir)) return [];
    const out: SessionBinding[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as SessionBinding;
        if (
          parsed &&
          typeof parsed.sessionId === 'string' &&
          typeof parsed.projectRoot === 'string' &&
          typeof parsed.flowName === 'string'
        ) {
          out.push(parsed);
        }
      } catch {
        /* skip corrupt file — it only affects its own session */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Remove a binding file by the session id stored inside it. */
export function removeBinding(sessionId: string): void {
  unbindSession(sessionId);
}
