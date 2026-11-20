import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitFixture, type GitFixture } from "../support/git-fixture";
import { startIsolatedProfile, type IsolatedProfile } from "../support/native-host";
import { parseLiveArgs } from "../support/native-host";

const CASE = "helpers-isolation";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;
const RUNNER = new URL("../support/helper-runner.ts", import.meta.url).pathname;
const SNAPSHOT = "a".repeat(64);

const fixtures: GitFixture[] = [];
const profiles: IsolatedProfile[] = [];
afterEach(async () => {
	for (const profile of profiles.splice(0)) profile.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function run(kind: "cold-read" | "review", cwd: string, prompt: string, profile: IsolatedProfile) {
	const job = { kind, cwd, prompt, binding: { taskId: "helper-fixture", epoch: 1, snapshotDigest: SNAPSHOT } };
	const child = Bun.spawn([process.execPath, RUNNER, JSON.stringify(job)], { cwd, env: profile.env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	if (exitCode !== 0) throw new Error(`helper child failed (${exitCode}): ${stderr.slice(-3000)}`);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
		kind: string; text: string; tools: string[]; model: { provider: string; id: string };
	};
}

test(`live ${CASE}: a cold reader gets no tools and a review gets only read-only tools`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await writeFile(join(fixture.source, "probe.txt"), "the cold reader must not see this without a tool\n");
	const profile = await startIsolatedProfile(args.campaign);
	profiles.push(profile);

	const cold = await run("cold-read", fixture.source, "Which tools can you call in this session? Answer with the exact list, or NONE.", profile);
	const coldRequests = profile.meter.requests();
	const review = await run("review", fixture.source, "Use the read tool to print the exact contents of probe.txt. Then stop.", profile);
	const requests = profile.meter.requests();

	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		case: CASE, campaign: args.campaign,
		cold: { tools: cold.tools, text: cold.text, model: cold.model, requests: coldRequests },
		review: { tools: review.tools, text: review.text.slice(0, 2000), model: review.model, requests: requests - coldRequests },
		meterFailures: profile.meter.failures(),
		probeAfter: await readFile(join(fixture.source, "probe.txt"), "utf8"),
	}, null, 2) + "\n");

	// Wire facts, not model prose: the cold-read request carried no tool definitions at all.
	const wire = profile.meter.tools();
	expect(wire[0]).toEqual([]);
	expect([...(wire[1] ?? [])].sort()).toEqual(["glob", "grep", "read"]);
	expect(cold.tools).toEqual([]);
	expect(review.tools).toEqual(["read", "grep", "glob"]);
	// The answer is recorded, but a model that lists imagined tools must not decide the verdict.
	expect(cold.text.length).toBeGreaterThan(0);
	expect(review.text).toContain("the cold reader must not see this without a tool");
	expect(cold.model.provider).toBe("llm-proxy-v2");
	expect(profile.meter.failures()).toEqual([]);
	expect(requests).toBeGreaterThanOrEqual(2);
}, 300_000);
