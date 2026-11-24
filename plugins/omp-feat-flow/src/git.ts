import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);

export interface PrepareInput {
  repo: string;
  remote: string;
  startRef: string;
  prBase: string;
  runId: string;
  branch: string;
  worktree: string;
}

export interface PreparedWorktree {
  runId: string;
  repo: string;
  repoIdentity: string;
  commonDir: string;
  worktree: string;
  worktreeGitDir: string;
  branch: string;
  remote: string;
  prBase: string;
  startSha: string;
  currentIntegrationSha: string;
  privateStartRef: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execute("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}

export async function prepare(input: PrepareInput): Promise<PreparedWorktree> {
  const repo = await realpath(await git(input.repo, ["rev-parse", "--show-toplevel"]));
  const commonDir = await realpath(await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const worktree = resolve(repo, input.worktree);
  const existing = await lstat(worktree).catch((error: unknown) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("The requested worktree path already exists and is not adopted.");
  const privateStartRef = `refs/omp-feat-flow/start/${input.runId}`;
  const start = input.startRef.startsWith(`refs/remotes/${input.remote}/`)
    ? input.startRef.slice(`refs/remotes/${input.remote}/`.length)
    : input.startRef.startsWith(`${input.remote}/`)
      ? input.startRef.slice(input.remote.length + 1)
      : input.startRef;
  const sourceRef = start.startsWith("refs/heads/") ? start : `refs/heads/${start}`;
  await git(repo, ["check-ref-format", "--branch", input.branch]);
  await git(repo, ["check-ref-format", sourceRef]);
  await git(repo, ["check-ref-format", privateStartRef]);
  if (await git(repo, ["for-each-ref", "--format=%(refname)", privateStartRef, `refs/heads/${input.branch}`])) {
    throw new Error("This run or branch already exists; reconcile it instead of preparing again.");
  }
  // Every refusal above happens before this fetch; rollback cleans ONLY refs/worktrees created by this attempt.
  let createdWorktree = false;
  try {
    await git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "--", input.remote, `${sourceRef}:${privateStartRef}`]);
    const startSha = await git(repo, ["rev-parse", "--verify", `${privateStartRef}^{commit}`]);
    await git(repo, ["worktree", "add", "-b", input.branch, "--", worktree, startSha]);
    createdWorktree = true;
    const worktreeGitDir = await realpath(await git(worktree, ["rev-parse", "--absolute-git-dir"]));
    return {
      runId: input.runId,
      repo, repoIdentity: commonDir, commonDir, worktree: await realpath(worktree), worktreeGitDir,
      branch: input.branch, remote: input.remote, prBase: input.prBase,
      startSha, currentIntegrationSha: startSha, privateStartRef,
    };
  } catch (error) {
    if (createdWorktree) {
      await git(repo, ["worktree", "remove", "--force", worktree]).catch(() => {});
      await rm(worktree, { recursive: true, force: true }).catch(() => {});
    }
    await git(repo, ["branch", "-D", input.branch]).catch(() => {});
    await git(repo, ["update-ref", "-d", privateStartRef]).catch(() => {});
    throw error;
  }
}

export interface RepositoryLocation {
  repo: string;
  repoIdentity: string;
  commonDir: string;
  worktreeGitDir: string;
  branch: string | null;
}

export async function inspectRepository(cwd: string): Promise<RepositoryLocation> {
  const repo = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const commonDir = await realpath(await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const worktreeGitDir = await realpath(await git(repo, ["rev-parse", "--absolute-git-dir"]));
  let branch = await git(repo, ["branch", "--show-current"]);
  if (!branch) {
    for (const dir of ["rebase-merge", "rebase-apply"]) {
      const headNamePath = join(worktreeGitDir, dir, "head-name");
      if (existsSync(headNamePath)) {
        const raw = readFileSync(headNamePath, "utf8").trim();
        if (raw.startsWith("refs/heads/")) {
          branch = raw.slice("refs/heads/".length);
          break;
        }
      }
    }
  }
  return { repo, repoIdentity: commonDir, commonDir, worktreeGitDir, branch: branch || null };
}

export interface SyncInput {
  repo: PreparedWorktree;
  /** Operation id recorded by the controller before any mutation. */
  operationId: string;
}

export type SyncOutcome = "synced" | "unchanged" | "conflict" | "foreign-dirt" | "unknown";

export interface SyncResult {
  outcome: SyncOutcome;
  /** The run's immutable origin SHA, never replaced by a sync. */
  startSha: string;
  previousIntegrationSha: string;
  /** Only a real, observed post-sync commit is reported; an unknown outcome carries the previous one. */
  newIntegrationSha: string;
  baseRef: string;
  detail: string;
}

/**
 * Advance the review base from the configured remote/base without touching origin history, the run's
 * start SHA, or foreign working-tree changes. The new base is reported only when Git actually moved.
 */
export async function sync(input: SyncInput): Promise<SyncResult> {
  const { repo } = input;
  const baseRef = `refs/feat-flow/${repo.runId}/base`;
  const result: SyncResult = { outcome: "unknown", startSha: repo.startSha,
    previousIntegrationSha: repo.currentIntegrationSha, newIntegrationSha: repo.currentIntegrationSha, baseRef, detail: "" };
  try {
    await git(repo.repo, ["fetch", "--no-tags", repo.remote, `+refs/heads/${repo.prBase}:${baseRef}`]);
  } catch (error) {
    return { ...result, detail: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const base = await git(repo.repo, ["rev-parse", `${baseRef}^{commit}`]).catch(() => "");
  if (!base) return { ...result, detail: "the fetched base ref is unreadable" };

  const dirty = await git(repo.worktree, ["status", "--porcelain"]);
  if (dirty.trim()) return { ...result, outcome: "foreign-dirt", detail: "the worktree has changes this sync does not own" };

  if (base === repo.currentIntegrationSha) return { ...result, outcome: "unchanged", detail: "the review base already matches" };

  try {
    await git(repo.worktree, ["rebase", base]);
  } catch (error) {
    const inProgress = await git(repo.worktree, ["rev-parse", "--git-path", "rebase-merge"]).catch(() => "");
    const unmerged = await git(repo.worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    return { ...result, outcome: "conflict",
      detail: `rebase stopped (${inProgress ? "rebase in progress" : "no rebase recorded"}); unmerged: ${unmerged.trim() || "none"}. ${error instanceof Error ? error.message.slice(0, 200) : ""}` };
  }
  const head = await git(repo.worktree, ["rev-parse", "HEAD"]);
  // Rebase rewrote the feature commits onto the base; HEAD's parent chain must now contain it.
  const contains = await git(repo.worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true).catch(() => false);
  if (!contains) return { ...result, outcome: "unknown", detail: "the rebase did not place the feature on the new base" };
  return { ...result, outcome: "synced", newIntegrationSha: base,
    detail: `rebased onto ${base.slice(0, 12)}; feature head ${head.slice(0, 12)}` };
}

export interface DiscoveredRunEntry {
  runId: string;
  branch: string;
  worktree: string;
  phase: string;
  issue: string | null;
  settledIssue: string | null;
  initialTask: string | null;
  workspaceId: string | null;
  worktreeExists: boolean;
}

export type DiscoveryMatch =
  | { kind: "run"; run: DiscoveredRunEntry }
  | { kind: "orphan-branch"; branch: string }
  | { kind: "path-exists"; path: string }
  | { kind: "none" };

export interface DiscoveryCatalog {
  runs: DiscoveredRunEntry[];
  branches: Set<string>;
  worktreePaths: Set<string>;
  match(query: { slug: string; boundIssue: string | null; targetWorktree?: string }): DiscoveryMatch;
}

export async function discoverRuns(commonDir: string, cwd: string): Promise<DiscoveryCatalog> {
  const runsDir = join(commonDir, "omp-feat-flow", "runs");
  const runs: DiscoveredRunEntry[] = [];
  if (existsSync(runsDir)) {
    for (const entry of await readdir(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const statePath = join(runsDir, entry.name, "state.json");
      if (!existsSync(statePath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(statePath, "utf8")) as {
          runId?: string;
          branch?: string;
          worktree?: string;
          phase?: string;
          issue?: string | null;
          initialTask?: string | null;
          operations?: Array<{ type?: string; status?: string; outcome?: string; receipt?: { reference?: string } | null }>;
          workspace?: { workspaceId?: string | null } | null;
        };
        if (!parsed.runId || !parsed.branch || !parsed.worktree) continue;
        const settledIssue = parsed.operations?.find(op =>
          op.type === "linear-issue" && op.status === "settled" && op.outcome === "applied" && op.receipt?.reference,
        )?.receipt?.reference ?? null;
        runs.push({
          runId: parsed.runId,
          branch: parsed.branch,
          worktree: parsed.worktree,
          phase: parsed.phase ?? "alignment",
          issue: parsed.issue ?? null,
          settledIssue,
          initialTask: typeof parsed.initialTask === "string" ? parsed.initialTask : null,
          workspaceId: parsed.workspace?.workspaceId ?? null,
          worktreeExists: existsSync(parsed.worktree),
        });
      } catch {
        // Isolate a corrupted run directory so other runs remain discoverable.
      }
    }
  }
  const branchesRaw = await git(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).catch(() => "");
  const branches = new Set(branchesRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean));

  const wtRaw = await git(cwd, ["worktree", "list", "--porcelain"]).catch(() => "");
  const worktreePaths = new Set<string>();
  for (const line of wtRaw.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      const p = line.slice("worktree ".length).trim();
      try { worktreePaths.add(await realpath(p)); } catch { worktreePaths.add(p); }
    }
  }

  return {
    runs,
    branches,
    worktreePaths,
    match({ slug, boundIssue, targetWorktree }) {
      if (boundIssue) {
        const byIssue = runs.find(r => r.issue === boundIssue || r.settledIssue === boundIssue);
        if (byIssue) return { kind: "run", run: byIssue };
      }
      const byId = runs.find(r => r.runId === slug);
      if (byId) return { kind: "run", run: byId };
      const expectedBranch = `feat/${slug}`;
      const byBranch = runs.find(r => r.branch === expectedBranch);
      if (byBranch) return { kind: "run", run: byBranch };
      if (branches.has(expectedBranch)) return { kind: "orphan-branch", branch: expectedBranch };
      if (targetWorktree) {
        let resolvedTarget = resolve(targetWorktree);
        try { resolvedTarget = realpathSync(resolvedTarget); } catch { /* path does not exist yet */ }
        if (existsSync(targetWorktree) || worktreePaths.has(resolvedTarget)) {
          return { kind: "path-exists", path: targetWorktree };
        }
      }
      return { kind: "none" };
    },
  };
}
