import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Feat Flow Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Feat Flow Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await execute("git", args, { cwd, env })).stdout;
}

export interface GitFixture {
  root: string;
  origin: string;
  seed: string;
  source: string;
  cleanup(): Promise<void>;
}

export async function gitFixture(): Promise<GitFixture> {
  const root = await mkdtemp(join(tmpdir(), "omp feat-flow-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const source = join(root, "source");
  try {
    await git(root, ["init", "--bare", "--initial-branch=main", origin]);
    await git(root, ["init", "--initial-branch=main", seed]);
    await Bun.write(join(seed, "README.md"), "base\n");
    await git(seed, ["add", "README.md"]);
    await git(seed, ["commit", "-m", "fixture: initial base"]);
    await git(seed, ["remote", "add", "origin", origin]);
    await git(seed, ["push", "origin", "main"]);
    await git(root, ["clone", origin, source]);
    return { root, origin, seed, source, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
