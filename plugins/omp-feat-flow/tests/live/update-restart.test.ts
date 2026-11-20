import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFixture, type InstallFixture } from "../support/install-fixture";
import { parseLiveArgs, startIsolatedProfile, startNativeHost, type NativeHost } from "../support/native-host";

const CASE = "update-restart";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The notify frame is the only place the running build identity is observable. */
async function buildLine(host: NativeHost): Promise<string> {
	const at = host.mark();
	const waiting = host.next(frame => frame.type === "extension_ui_request" && frame.method === "notify"
		&& /Build: /.test(String(frame.message)), "update notify", 60_000, at);
	await host.prompt("/feat-flow-update");
	const text = String((await waiting).message);
	const match = /Build: (same|stale|unknown) \(([^)]*)\)/.exec(text);
	if (!match) throw new Error(`no build line in ${text.slice(0, 600)}`);
	return match[0];
}

test(`live ${CASE}: an upgraded installation is not reported as running until a real restart`, async () => {
	if (args.only && args.only !== CASE) return;
	const profile = await startIsolatedProfile(args.campaign);
	cleanups.push(() => profile.stop());
	const fixture: InstallFixture = await installFixture({ profile, env: profile.env });
	cleanups.push(() => fixture.cleanup());

	await fixture.install("0.1.0", "A");
	const installedA = await fixture.installedRelease();
	expect(installedA?.version).toBe("0.1.0");

	const cwd = await mkdtemp(join(tmpdir(), "omp-feat-update-cwd-"));
	const first = await startNativeHost(cwd, args.campaign, { installed: true, profile });
	cleanups.push(() => first.stop());

	const before = await buildLine(first);
	expect(before).toContain("Build: same");
	expect(before).toContain(installedA!.buildId.slice(0, 12));

	// Upgrade the installation underneath the running process.
	await fixture.install("0.1.1", "B");
	const installedB = await fixture.installedRelease();
	expect(installedB?.version).toBe("0.1.1");
	expect(installedB!.buildId).not.toBe(installedA!.buildId);

	const during = await buildLine(first);
	// Stale names both identities: the one running and the one only a restart can load.
	expect(during).toContain("Build: stale");
	expect(during).toContain(installedA!.buildId.slice(0, 12));
	expect(during).toContain(installedB!.buildId.slice(0, 12));
	expect(during).toContain("reload-plugins does not replace loaded code");

	await first.stop();
	const second = await startNativeHost(cwd, args.campaign, { installed: true, profile });
	cleanups.push(() => second.stop());
	const after = await buildLine(second);
	expect(after).toContain("Build: same");
	expect(after).toContain(installedB!.buildId.slice(0, 12));

	await Bun.write(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		versionA: installedA!.version, buildA: installedA!.buildId,
		versionB: installedB!.version, buildB: installedB!.buildId,
		beforeRestart: during, afterRestart: after,
	}, null, 2) + "\n");
}, 300_000);
