import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { installFixture, type InstallFixture } from "../support/install-fixture";
import { LIVE_MODEL, parseLiveArgs, startIsolatedProfile, type IsolatedProfile } from "../support/native-host";
import { seedProject } from "../support/project";
import { driveTui, TUI_CLI_DIR } from "../support/tui";

const CASE = "recovery-manual-tui";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); }, 120_000);

test(`live ${CASE}: manual compaction in the real TUI keeps the run observable`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture: GitFixture = await gitFixture();
	cleanups.push(() => fixture.cleanup());
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);

	const profile: IsolatedProfile = await startIsolatedProfile(args.campaign, true, {
		OMP_FEAT_FLOW_SKILLS_DIR: join(process.env.HOME ?? "", ".agents", "skills"),
	});
	cleanups.push(() => profile.stop());
	const install: InstallFixture = await installFixture({ profile, env: profile.env });
	cleanups.push(() => install.cleanup());
	await install.install("0.1.0", "tui-manual");
	// The first-run wizard is not what this case tests; mark setup complete.
	await Bun.write(join(profile.agentDir, "config.yml"),
		(await Bun.file(join(profile.agentDir, "config.yml")).text()) + "setupVersion: 3\n");

	const screen = await driveTui({
		profile: profile.agentDir, home: profile.home, cwd: TUI_CLI_DIR, workdir: fixture.source,
		model: LIVE_MODEL, env: profile.env,
		steps: [
			{ afterMs: 9_000, text: "/feat-flow-start desk-tui\r" },
			{ afterMs: 20_000, text: "reply with the single word OK\r" },
			{ afterMs: 30_000, text: "reply with the single word OK\r" },
			{ afterMs: 40_000, text: "/compact" },
			{ afterMs: 40_600, text: "\r" },
			{ afterMs: 75_000, text: "/feat-flow-status\r" },
			{ afterMs: 80_000, text: "/feat-flow-status\r" },
		],
		totalMs: 88_000,
	});
	await Bun.write(join(EVIDENCE, `${CASE}.txt`), screen);

	// The run survives a manual compaction typed in the real terminal UI.
	const afterCompact = screen.slice(Math.max(0, screen.indexOf("/compact")));
	expect(screen).toContain("run desk-tui created");
	// The TUI's own compaction banner, then the same run still observable afterwards.
	expect(afterCompact).toMatch(/compacted/i);
	expect(afterCompact).toMatch(/desk-tui r\d/);
}, 300_000);
