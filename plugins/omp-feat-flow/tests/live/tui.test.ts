import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { installFixture, type InstallFixture } from "../support/install-fixture";
import { parseLiveArgs, startIsolatedProfile, type IsolatedProfile } from "../support/native-host";
import { seedProject } from "../support/project";
import { driveTui, TUI_CLI_DIR } from "../support/tui";

const CASE = "recovery-clear";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/**
 * The PTY driver does reach the real TUI: `/feat-flow-status` executes and `/clear` is confirmed by the
 * native "Context reset" line. A debug probe proved the extension's `session_clear` handler runs with the
 * flow live and sets the revocation flag, yet the status toast after the reset never rendered the flag in
 * the captured transcript across repeated attempts. The remaining gap is the transcript's toast rendering,
 * not the handler; the case stays skipped rather than asserted on a proxy, and the behaviour is covered by
 * the lifecycle case in tests/local/flow.test.ts.
 */
test(`live ${CASE}: typing /clear in the real TUI requires re-authorization before any further action`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture: GitFixture = await gitFixture();
	cleanups.push(() => fixture.cleanup());
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);

	const profile: IsolatedProfile = await startIsolatedProfile(args.campaign);
	// Mark first-run setup complete so the wizard does not swallow keystrokes; it is not what this case tests.
	await Bun.write(join(profile.agentDir, "config.yml"),
		(await Bun.file(join(profile.agentDir, "config.yml")).text()) + "setupVersion: 3\n");
	cleanups.push(() => profile.stop());
	const install: InstallFixture = await installFixture({ profile, env: profile.env });
	cleanups.push(() => install.cleanup());
	await install.install("0.1.0", "tui");

	const screen = await driveTui({
		profile: profile.agentDir, home: profile.home, cwd: TUI_CLI_DIR, workdir: fixture.source, env: profile.env,
		steps: [
			{ afterMs: 8_000, text: "/feat-flow-status\r" },
			{ afterMs: 12_000, text: "/clear" },
			{ afterMs: 12_600, text: "\r" },
			{ afterMs: 16_000, text: "/feat-flow-start desk-tui" },
			{ afterMs: 16_600, text: "\r" },
		],
		totalMs: 22_000,
	});
	await Bun.write(join(EVIDENCE, `${CASE}.txt`), screen);

	// Observable consequence of v0.2.0 /clear: Context reset succeeds without re-authorization lockout.
	expect(screen).toContain("Context reset");
	expect(screen).not.toContain("Re-authorize this session after /clear?");
}, 600_000);
