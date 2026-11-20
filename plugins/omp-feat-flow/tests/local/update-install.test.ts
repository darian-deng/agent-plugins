import { expect, test } from "bun:test";
import { installFixture } from "../support/install-fixture";
import { inspectUpdate } from "../../src/update";

/** Drives the real native installer; no inference request is made here. */
test("a same-version reinstall is a different build, and never the running one", async () => {
	const fixture = await installFixture();
	try {
		await fixture.install("0.1.0", "A");
		const first = await fixture.installedRelease();
		await fixture.install("0.1.0", "C");
		const second = await fixture.installedRelease();
		expect(first?.version).toBe("0.1.0");
		expect(second?.version).toBe("0.1.0");
		expect(second!.buildId).not.toBe(first!.buildId);

		const assessment = inspectUpdate({ loadedBuildId: first!.buildId, installed: second!, unresolvedEffects: 0 });
		expect(assessment).toMatchObject({ relation: "stale", requiresRestart: true });
	} finally {
		await fixture.cleanup();
	}
	}, 180_000);
