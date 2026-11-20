import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { parseLiveArgs, startNativeHost, type NativeHost } from "../support/native-host";
import { seedProject } from "../support/project";

const CASE = "sync-receipt";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const hosts: NativeHost[] = [];
const fixtures: GitFixture[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function notify(host: NativeHost, prompt: string, pattern: RegExp, timeoutMs = 120_000): Promise<string> {
	const at = host.mark();
	const waiting = host.next(frame => frame.type === "extension_ui_request" && frame.method === "notify"
		&& pattern.test(String(frame.message)), `notify ${pattern}`, timeoutMs, at);
	await host.prompt(prompt);
	return String((await waiting).message);
}

async function setup(): Promise<{ fixture: GitFixture; host: NativeHost }> {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, {
		// Positive start cases need the developer's installed methods; the isolated HOME has none.
		env: { OMP_FEAT_FLOW_SKILLS_DIR: join(process.env.HOME ?? "", ".agents", "skills") },
	});
	hosts.push(host);
	await notify(host, "/feat-flow-start desk-sync", /run desk-sync created|blocked/i);
	return { fixture, host };
}

test(`live ${CASE}: a real base advance is synced and moves the recorded baseline`, async () => {
	if (args.only && args.only !== CASE) return;
	const { fixture, host } = await setup();
	const before = await notify(host, "/feat-flow-status", /baseline /);

	// A genuine advance on the remote PR base.
	await writeFile(join(fixture.seed, "base.txt"), "advance\n");
	await git(fixture.seed, ["add", "-A"]);
	await git(fixture.seed, ["-c", "user.email=f@e", "-c", "user.name=f", "commit", "-m", "advance"]);
	await git(fixture.seed, ["push", "origin", "main:staging"]);

	const synced = await notify(host, "/feat-flow-sync", /synced|already on|sync /i, 180_000);
	const after = await notify(host, "/feat-flow-status", /baseline /);
	expect(synced).toMatch(/synced|already on/);
	expect(after).not.toBe(before);

	await Bun.write(join(EVIDENCE, `${CASE}.json`), JSON.stringify({ before, synced, after }, null, 2) + "\n");
}, 300_000);

test(`live ${CASE}: a real conflict is left inspectable instead of being reported as synced`, async () => {
	if (args.only && args.only !== CASE) return;
	const { fixture, host } = await setup();
	// Defaults keep worktrees beside the repository, not inside it.
	const worktree = join(fixture.source, "..", "source-worktrees", "desk-sync");
	// Local progress and a conflicting remote commit touch the same file.
	await writeFile(join(worktree, "conflict.txt"), "local\n");
	await git(worktree, ["add", "-A"]);
	await git(worktree, ["-c", "user.email=f@e", "-c", "user.name=f", "commit", "-m", "local"]);
	await writeFile(join(fixture.seed, "conflict.txt"), "remote\n");
	await git(fixture.seed, ["add", "-A"]);
	await git(fixture.seed, ["-c", "user.email=f@e", "-c", "user.name=f", "commit", "-m", "remote"]);
	await git(fixture.seed, ["push", "origin", "main:staging"]);

	const result = await notify(host, "/feat-flow-sync", /conflict|synced|already/i, 180_000);
	expect(result).toMatch(/conflict/);
	const status = await git(worktree, ["status", "--porcelain"]);
	expect(status).toMatch(/^(UU|AA|DU|UD|AU|UA) conflict\.txt/m);
	// Leave the fixture's rebase aborted so cleanup never has to guess.
	await git(worktree, ["rebase", "--abort"]).catch(() => {});
	await Bun.write(join(EVIDENCE, `${CASE}-conflict.json`), JSON.stringify({ result, status }, null, 2) + "\n");
}, 300_000);
