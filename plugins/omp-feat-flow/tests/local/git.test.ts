import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, stat } from "node:fs/promises";
import { prepare, sync } from "../../src/git";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const fixtures: GitFixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });

test("prepare preserves dirty source and starts from freshly fetched main", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const { source, seed, root } = fixture;
  const originalHead = (await git(source, ["rev-parse", "HEAD"])).trim();
  await git(source, ["switch", "-c", "existing-work"]);
  await Bun.write(join(source, "README.md"), "developer staged work\n");
  await git(source, ["add", "README.md"]);
  await Bun.write(join(source, "notes.txt"), "developer untracked notes\n");
  await Bun.write(join(seed, "README.md"), "upstream v2\n");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "fixture: upstream advanced"]);
  await git(seed, ["push", "origin", "main"]);
  const upstream = (await git(seed, ["rev-parse", "HEAD"])).trim();
  const result = await prepare({ repo: source, remote: "origin", startRef: "main", prBase: "main",
    runId: "feature-a", branch: "feat/feature-a", worktree: join(root, "feature-a") });
  expect({
    branch: (await git(result.worktree, ["branch", "--show-current"])).trim(),
    head: (await git(result.worktree, ["rev-parse", "HEAD"])).trim(),
    start: result.startSha, integration: result.currentIntegrationSha,
    originalHead: (await git(source, ["rev-parse", "HEAD"])).trim(),
    originalBranch: (await git(source, ["branch", "--show-current"])).trim(),
    originalStatus: await git(source, ["status", "--porcelain=v1"]),
    staged: await git(source, ["show", ":README.md"]),
    untracked: await Bun.file(join(source, "notes.txt")).text(),
    preparedReadme: await Bun.file(join(result.worktree, "README.md")).text(),
  }).toEqual({ branch: "feat/feature-a", head: upstream, start: upstream, integration: upstream,
    originalHead, originalBranch: "existing-work", originalStatus: "M  README.md\n?? notes.txt\n",
    staged: "developer staged work\n", untracked: "developer untracked notes\n", preparedReadme: "upstream v2\n" });
});

test("two preparations cannot reuse or mutate an existing run anchor", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const { source, seed, root } = fixture;
  const first = await prepare({ repo: source, remote: "origin", startRef: "main", prBase: "main",
    runId: "feature-a", branch: "feat/a", worktree: join(root, "feature-a") });
  const initial = (await git(seed, ["rev-parse", "HEAD"])).trim();
  await Bun.write(join(seed, "README.md"), "next upstream\n");
  await git(seed, ["add", "README.md"]);
  await git(seed, ["commit", "-m", "fixture: next upstream"]);
  await git(seed, ["push", "origin", "main"]);
  const next = (await git(seed, ["rev-parse", "HEAD"])).trim();
  await expect(prepare({ repo: source, remote: "origin", startRef: "main", prBase: "main",
    runId: "feature-a", branch: "feat/b", worktree: join(root, "feature-b") })).rejects.toBeInstanceOf(Error);
  const second = await prepare({ repo: source, remote: "origin", startRef: "main", prBase: "main",
    runId: "feature-b", branch: "feat/b", worktree: join(root, "feature-b") });
  expect([
    (await git(source, ["rev-parse", first.privateStartRef])).trim(),
    (await git(source, ["rev-parse", second.privateStartRef])).trim(),
    (await git(first.worktree, ["rev-parse", "HEAD"])).trim(),
    (await git(second.worktree, ["rev-parse", "HEAD"])).trim(),
  ]).toEqual([initial, next, initial, next]);
});

test("existing unrelated directory is not adopted or deleted", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const target = join(fixture.root, "developer-directory");
  await mkdir(target);
  await expect(prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
    runId: "blocked", branch: "feat/blocked", worktree: target })).rejects.toBeInstanceOf(Error);
  expect({
    directoryRetained: (await stat(target)).isDirectory(),
    refs: await git(fixture.source, ["for-each-ref", "--format=%(refname)",
      "refs/heads/feat/blocked", "refs/omp-feat-flow/start/blocked"]),
  }).toEqual({ directoryRetained: true, refs: "" });
});

test("sync advances the review base but not the start SHA and preserves only the feature diff", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const { source, seed, root } = fixture;
  const repo = await prepare({ repo: source, remote: "origin", startRef: "main", prBase: "main",
    runId: "sync", branch: "feat/sync", worktree: join(root, "sync") });
  // Owned feature work.
  await Bun.write(join(repo.worktree, "feature.txt"), "owned feature change\n");
  await git(repo.worktree, ["add", "feature.txt"]);
  await git(repo.worktree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "feature: add file"]);
  const featureHead = (await git(repo.worktree, ["rev-parse", "HEAD"])).trim();
  // The remote base advances.
  await Bun.write(join(seed, "upstream.txt"), "upstream change\n");
  await git(seed, ["add", "upstream.txt"]);
  await git(seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "upstream: add file"]);
  await git(seed, ["push", "origin", "main"]);

  const result = await sync({ repo, operationId: "op-1" });
  expect(result.outcome).toBe("synced");
  expect(result.startSha).toBe(repo.startSha);
  expect(result.newIntegrationSha).not.toBe(repo.currentIntegrationSha);

  const status = (await git(repo.worktree, ["status", "--porcelain"])).trim();
  expect(status).toBe("");
  const diffNames = (await git(repo.worktree, ["diff", "--name-only", `${result.newIntegrationSha}...HEAD`])).trim().split("\n");
  expect(diffNames).toEqual(["feature.txt"]);
  expect((await git(repo.worktree, ["rev-parse", "HEAD"])).trim()).not.toBe(featureHead);
  expect(await git(repo.worktree, ["cat-file", "-e", `${result.newIntegrationSha}^{commit}`]).then(() => true).catch(() => false)).toBe(true);

  // A second sync with an unchanged base is a no-op, not a fabricated move.
  const again = await sync({ repo: { ...repo, currentIntegrationSha: result.newIntegrationSha }, operationId: "op-2" });
  expect(again.outcome).toBe("unchanged");
  expect(again.newIntegrationSha).toBe(result.newIntegrationSha);
});

test("sync refuses foreign dirt and reports a real conflict without inventing a base", async () => {
  const fixture = await gitFixture();
  fixtures.push(fixture);
  const { source, seed, root } = fixture;
  const repo = await prepare({ repo: source, remote: "origin", startRef: "main", prBase: "main",
    runId: "sync2", branch: "feat/sync2", worktree: join(root, "sync2") });
  await Bun.write(join(repo.worktree, "conflict.txt"), "feature side\n");
  await git(repo.worktree, ["add", "conflict.txt"]);
  await git(repo.worktree, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "feature side"]);
  await Bun.write(join(seed, "conflict.txt"), "upstream side\n");
  await git(seed, ["add", "conflict.txt"]);
  await git(seed, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "upstream side"]);
  await git(seed, ["push", "origin", "main"]);

  // Foreign dirt blocks before any mutation.
  await Bun.write(join(repo.worktree, "untracked-by-flow.txt"), "someone else\n");
  const blocked = await sync({ repo, operationId: "op-3" });
  expect(blocked.outcome).toBe("foreign-dirt");
  expect(blocked.newIntegrationSha).toBe(repo.currentIntegrationSha);
  await git(repo.worktree, ["clean", "-f", "untracked-by-flow.txt"]);

  const conflicted = await sync({ repo, operationId: "op-4" });
  expect(conflicted.outcome).toBe("conflict");
  expect(conflicted.newIntegrationSha).toBe(repo.currentIntegrationSha);
  expect(conflicted.detail).toContain("rebase");
  // The real interruption is inspectable rather than tidied away.
  const state = (await git(repo.worktree, ["status", "--porcelain"])).trim();
  expect(state).toMatch(/^(UU|AA|DU|UD|AU|UA) conflict\.txt/m);
  await git(repo.worktree, ["rebase", "--abort"]);
});

test("a refused prepare never deletes an existing run's private start ref", async () => {
	const fixture = await gitFixture();
	try {
		await git(fixture.seed, ["push", "origin", "main:staging"]);
		// Another run already owns this slug's anchor ref.
		const anchor = (await git(fixture.source, ["rev-parse", "HEAD"])).trim();
		await git(fixture.source, ["update-ref", "refs/omp-feat-flow/start/desk-1", anchor]);
		await expect(prepare({ repo: fixture.source, remote: "origin", startRef: "origin/staging", prBase: "staging",
			runId: "desk-1", branch: "feat/desk-1", worktree: join(fixture.root, "desk-1") })).rejects.toThrow(/already exists/);
		const after = (await git(fixture.source, ["rev-parse", "--verify", "refs/omp-feat-flow/start/desk-1"])).trim();
		expect(after).toBe(anchor);
	} finally {
		await fixture.cleanup();
	}
});
