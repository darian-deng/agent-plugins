import { expect, test } from "bun:test";
import { inspectUpdate } from "../../src/update";

const loaded = "1".repeat(64);

test("an installed build is never reported as running", () => {
	const same = inspectUpdate({ loadedBuildId: loaded, installed: { buildId: loaded, version: "0.1.0" }, unresolvedEffects: 0 });
	expect(same).toMatchObject({ relation: "same", requiresRestart: false });

	const stale = inspectUpdate({ loadedBuildId: loaded, installed: { buildId: "2".repeat(64), version: "0.2.0" }, unresolvedEffects: 0 });
	expect(stale).toMatchObject({ relation: "stale", requiresRestart: true });
	expect(stale.detail).toContain("reload-plugins does not replace loaded code");
});

test("unsettled effects and unreadable metadata block an upgrade", () => {
	expect(inspectUpdate({ loadedBuildId: loaded, installed: { buildId: "2".repeat(64), version: "0.2.0" }, unresolvedEffects: 1 }))
		.toMatchObject({ relation: "unknown", requiresRestart: false });
	expect(inspectUpdate({ loadedBuildId: loaded, installed: null, unresolvedEffects: 0 }))
		.toMatchObject({ relation: "unknown", requiresRestart: false });
});

test("the release metadata is an identity record, not executable resources", async () => {
	const release = JSON.parse(await Bun.file(new URL("../../runtime/release.json", import.meta.url)).text()) as {
		buildId: string; bundleSha256: string; version: string; tools: Record<string, string>; capabilities: string[];
	};
	expect(release.buildId).toMatch(/^[a-f0-9]{64}$/);
	expect(release.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(release.tools).toMatchObject({ esbuild: "0.25.12", sdk: "19.0.0" });
	expect(release.capabilities).toContain("tool-call-admission");
	expect(JSON.stringify(release)).not.toContain("scripts/");
});
