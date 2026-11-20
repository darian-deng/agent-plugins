import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { seedProject } from "../support/project";
import { framesText, parseLiveArgs, startNativeHost, type NativeHost } from "../support/native-host";

const args = parseLiveArgs();
const CASE = "recovery-manual-rpc";
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;
const INSTALLED_SKILLS = { OMP_FEAT_FLOW_SKILLS_DIR: join(homedir(), ".agents", "skills") };

const fixtures: GitFixture[] = [];
const hosts: NativeHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function approve(host: NativeHost): Promise<void> {
	const approving = host.startPrompt("/feat-flow-approve");
	const frame = await host.next(item => item.type === "extension_ui_request" && item.method === "confirm", "native confirm", 120_000);
	host.send({ type: "extension_ui_response", id: frame.id, confirmed: true });
	await approving.result;
}

const AUTO = "recovery-auto";

test(`live ${AUTO}: automatic compaction continuation carries the receipt`, async () => {
	if (args.only && args.only !== AUTO) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	// A realistic trigger: one material-bearing turn pushes context past it, and compaction can reduce.
	const host = await startNativeHost(fixture.source, args.campaign,
		{ env: INSTALLED_SKILLS, compaction: { thresholdTokens: 20000, keepRecentTokens: 2000 } });
	hosts.push(host);
	try {
		await host.prompt("/feat-flow-start desk-auto");
		await host.prompt('Call the tool named exactly feat_flow_request once with arguments '
			+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. Then stop.');
		await approve(host);
		const names: string[] = [];
		for (const name of ["material-a.md", "material-b.md", "material-c.md", "material-d.md"]) {
			const body = Array.from({ length: 1400 }, (_, index) => `- ${name} line ${index}: the bounded export path keeps its contract.`).join("\n");
			await writeFile(join(fixture.source, name), body);
			names.push(name);
		}
		await host.prompt(`Read ${names.join(", ")} fully, then stop.`);
		const after = await host.prompt("Continue with the next step and stop.");
		const sentinels = host.meter.sentinels();
		const transcript = framesText(host.frames);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${AUTO}.json`), JSON.stringify({
			case: AUTO, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			after: { status: after.status }, sentinels, compacted: transcript.includes("compact_boundary") || transcript.includes("compaction"),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${AUTO}.rpc.jsonl`), transcript + "\n");
		expect(host.meter.failures()).toEqual([]);
		expect(sentinels.join("\n")).toContain("approved yes");
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${AUTO}.failure.json`), JSON.stringify({
			case: AUTO, failure: error instanceof Error ? error.message : String(error),
			requests: host.meter.requests(), sentinels: host.meter.sentinels(),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${AUTO}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 420_000);

const FRESH = "recovery-fresh-process";

test(`live ${FRESH}: a fresh process in the same cwd relocates the run without inheriting authority`, async () => {
	if (args.only && args.only !== FRESH) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const first = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(first);
	await first.prompt("/feat-flow-start desk-fresh");
	await first.prompt('Call the tool named exactly feat_flow_request once with arguments '
		+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. Then stop.');
	await approve(first);
	await first.stop();
	hosts.splice(hosts.indexOf(first), 1);

	// The locator lives in the run's worktree, so a fresh process relocates it from there.
	const worktree = join(fixture.root, "source-worktrees", "desk-fresh");
	const second = await startNativeHost(worktree, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(second);
	try {
		const after = await second.prompt("/feat-flow-status");
		const write = await second.prompt("Use the write tool to create out.txt containing leaked. Then stop.");
		const sentinels = second.meter.sentinels();
		const transcript = framesText(second.frames);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${FRESH}.json`), JSON.stringify({
			case: FRESH, campaign: args.campaign, requests: second.meter.requests(), meterFailures: second.meter.failures(),
			after: { status: after.status }, write: { status: write.status }, sentinels,
			outFile: await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${FRESH}.rpc.jsonl`), transcript + "\n");
		// Relocation is proven by the status line and receipt; non-inheritance by the blocked write.
		expect(transcript).toContain("owner-authorization-required");
		expect(sentinels.join("\n")).toContain("approved yes");
		expect(sentinels.join("\n")).toContain("owner-authorization-required");
		expect(transcript).toContain("feat-flow denied this write: owner-recovery");
		expect(await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null)).toBeNull();
		expect(second.meter.failures()).toEqual([]);
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${FRESH}.failure.json`), JSON.stringify({
			case: FRESH, failure: error instanceof Error ? error.message : String(error), sentinels: second.meter.sentinels(),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${FRESH}.failure.rpc.jsonl`), framesText(second.frames) + "\n");
		throw error;
	}
}, 420_000);

const FAILURE = "recovery-failure";

test(`live ${FAILURE}: a corrupted bound material blocks recovery and refuses the write`, async () => {
	if (args.only && args.only !== FAILURE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	try {
		await host.prompt("/feat-flow-start desk-fail");
		await host.prompt('Call the tool named exactly feat_flow_request once with arguments '
			+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. Then stop.');
		await approve(host);
		// Corrupt the exact approved material the run points at.
		const state = JSON.parse(await readFile(join(fixture.source, ".git", "omp-feat-flow", "runs", "desk-fail", "state.json"), "utf8")) as {
			approvedScope: { contentPath: string } | null;
		};
		if (!state.approvedScope) throw new Error("The approval did not bind a material.");
		await writeFile(state.approvedScope.contentPath, "{\"content\":\"tampered\"}\n");
		const status = await host.prompt("/feat-flow-status");
		const write = await host.prompt("Use the write tool to create out.txt containing leaked. Then stop.");
		const transcript = framesText(host.frames);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${FAILURE}.json`), JSON.stringify({
			case: FAILURE, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			status: { status: status.status }, write: { status: write.status },
			outFile: await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${FAILURE}.rpc.jsonl`), transcript + "\n");
		expect(transcript).toContain("bound-material-unavailable");
		expect(await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null)).toBeNull();
		expect(host.meter.failures()).toEqual([]);
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${FAILURE}.failure.json`), JSON.stringify({
			case: FAILURE, failure: error instanceof Error ? error.message : String(error),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${FAILURE}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 420_000);

const NEW = "recovery-new";

test(`live ${NEW}: a new session relocates the run and must re-authorize`, async () => {
	if (args.only && args.only !== NEW) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	try {
		await host.prompt("/feat-flow-start desk-new");
		await host.prompt('Call the tool named exactly feat_flow_request once with arguments '
			+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. Then stop.');
		await approve(host);
		const created = await host.call({ type: "new_session" });
		// The new session resumes the bound run from the worktree and needs an explicit owner grant.
		const mark = host.mark();
		const started = host.startPrompt("/feat-flow-start desk-new");
		const frame = await host.next(item => item.type === "extension_ui_request" && item.method === "confirm", "owner confirm", 120_000, mark);
		host.send({ type: "extension_ui_response", id: frame.id, confirmed: true });
		await started.result;
		const write = await host.prompt("Use the write tool to create out.txt containing leaked. Then stop.");
		const transcript = framesText(host.frames);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${NEW}.json`), JSON.stringify({
			case: NEW, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			newSession: { success: created.success }, started: { title: frame.title }, write: { status: write.status },
			outFile: await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${NEW}.rpc.jsonl`), transcript + "\n");
		expect(transcript).toContain("authorized this session for desk-new");
		expect(host.meter.failures()).toEqual([]);
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${NEW}.failure.json`), JSON.stringify({
			case: NEW, failure: error instanceof Error ? error.message : String(error), requests: host.meter.requests(),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${NEW}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 420_000);

test(`live ${CASE}: the first request after manual compaction carries the run receipt`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	try {
		await host.prompt("/feat-flow-start desk-recover");
		const material = Array.from({ length: 400 }, (_, index) => `- fixture line ${index}: the export path stays bounded.`).join("\n");
		await writeFile(join(fixture.source, "fixture-material.md"), material);
		await host.prompt("Read fixture-material.md fully, then stop.");
		await host.prompt('Call the tool named exactly feat_flow_request once with arguments '
			+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. Then stop.');
		await approve(host);
		const beforeCompact = host.meter.requests();
		const compaction = await host.call({ type: "compact" });
		// The queued recovery message is consumed by the first following business request.
		const after = await host.prompt("Continue with the next step and stop.");
		const sentinels = host.meter.sentinels();
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
			case: CASE, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			beforeCompact, compact: { success: compaction.success }, after: { status: after.status }, sentinels,
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CASE}.rpc.jsonl`), framesText(host.frames) + "\n");
		expect(host.meter.failures()).toEqual([]);
		expect(sentinels.length).toBeGreaterThan(0);
		expect(sentinels.join("\n")).toContain("approved yes");
		expect(sentinels.join("\n")).toContain("phase implementation");
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CASE}.failure.json`), JSON.stringify({
			case: CASE, failure: error instanceof Error ? error.message : String(error),
			requests: host.meter.requests(), meterFailures: host.meter.failures(),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CASE}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 420_000);
