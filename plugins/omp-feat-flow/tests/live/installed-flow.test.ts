import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { seedProject } from "../support/project";
import { installFixture, type InstallFixture } from "../support/install-fixture";
import { parseLiveArgs, startIsolatedProfile, startNativeHost, type NativeHost } from "../support/native-host";

const CASE = "installed-flow";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function notify(host: NativeHost, prompt: string, pattern: RegExp): Promise<string> {
	const at = host.mark();
	const waiting = host.next(frame => frame.type === "extension_ui_request" && frame.method === "notify"
		&& pattern.test(String(frame.message)), `notify ${pattern}`, 180_000, at);
	await host.prompt(prompt);
	return String((await waiting).message);
}

test(`live ${CASE}: the installed artifact drives a real run and its own admission`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture: GitFixture = await gitFixture();
	cleanups.push(() => fixture.cleanup());
	// The run starts from the configured PR base, so the fixture remote must actually have it.
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const profile = await startIsolatedProfile(args.campaign, true, {
		// Methods come from the developer's installed skills; the isolated HOME has none.
		OMP_FEAT_FLOW_SKILLS_DIR: join(process.env.HOME ?? "", ".agents", "skills"),
	});
	cleanups.push(() => profile.stop());
	const install: InstallFixture = await installFixture({ profile, env: profile.env });
	cleanups.push(() => install.cleanup());
	await install.install("0.1.0", "installed-flow");

	const host = await startNativeHost(fixture.source, args.campaign, { installed: true, profile });
	cleanups.push(() => host.stop());

	const commands = JSON.stringify((await host.call({ type: "get_available_commands" })).data ?? "");
	expect(commands).toContain("feat-flow-start");

	const started = await notify(host, "/feat-flow-start desk-installed", /run|owner|phase|blocked/i);
	expect(started.length).toBeGreaterThan(0);

	const status = await notify(host, "/feat-flow-status", /phase|owner|build/i);
	expect(status).not.toMatch(/no run|not started/i);

	// The installed build really created its private worktree, not just a record.
	const worktrees = join(fixture.source, ".git", "worktrees");
	expect(existsSync(worktrees)).toBe(true);

	const buildLine = await notify(host, "/feat-flow-update", /Build: /);
	expect(buildLine).toContain("Build: same");

	await Bun.write(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		installed: await install.installedRelease(), started, status, buildLine, requests: host.meter.requests(),
	}, null, 2) + "\n");
}, 600_000);
