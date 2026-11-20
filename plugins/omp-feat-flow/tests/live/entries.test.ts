import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { seedProject } from "../support/project";
import { framesText, parseLiveArgs, startNativeHost, type NativeHost } from "../support/native-host";
import { homedir } from "node:os";

const args = parseLiveArgs();
const CASE = "entry-prd-boundary";
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;
const INSTALLED_SKILLS = { OMP_FEAT_FLOW_SKILLS_DIR: join(homedir(), ".agents", "skills") };

const PRD = `# Export requirement

## Reliable answers
- Exports are under 50 MB.
- Exports are written to disk today.

## Decisions
- non-goals: No new database table.
- acceptance: A 50 MB export completes in under two minutes.
`;

const fixtures: GitFixture[] = [];
const hosts: NativeHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

test(`live ${CASE}: an unclear PRD still exposes its unresolved boundary and keeps implementation closed`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const prdPath = join(fixture.source, "export-prd.md");
	await writeFile(prdPath, PRD);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	try {
		await host.prompt("/feat-flow-start desk-prd");
		const grilled = await host.prompt(`Call the tool named exactly feat_flow_request once with arguments {"prdPath": ${JSON.stringify(prdPath)}}. Then stop.`);
		const status = await host.prompt("/feat-flow-status");
		const write = await host.prompt("Use the write tool to create out.txt containing leaked in the current directory. Then stop.");
		const transcript = framesText(host.frames);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
			case: CASE, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			grilled: { status: grilled.status }, status: { status: status.status }, write: { status: write.status },
			outFile: await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CASE}.rpc.jsonl`), transcript + "\n");

		expect(transcript).toContain("decided: non-goals, acceptance");
		expect(transcript).toContain("open: goals, business-boundary, error-path");
		expect(transcript).toContain("approved no");
		expect(transcript).toContain("scope-not-approved");
		expect(await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null)).toBeNull();
		await expect(readFile(prdPath, "utf8")).resolves.toBe(PRD);
		expect(host.meter.failures()).toEqual([]);
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CASE}.failure.json`), JSON.stringify({
			case: CASE, failure: error instanceof Error ? error.message : String(error),
			requests: host.meter.requests(), meterFailures: host.meter.failures(),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CASE}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 300_000);

const CONVERSATION = "entry-conversation";

test(`live ${CONVERSATION}: a bounded conversation entry is not re-interviewed and is not auto-approved`, async () => {
	if (args.only && args.only !== CONVERSATION) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	const boundaries = { decided: [
		{ category: "goals", answer: "Ship the bounded export." },
		{ category: "business-boundary", answer: "Only the owning team may export." },
		{ category: "error-path", answer: "A failed export returns 503 and leaves no partial file." },
		{ category: "non-goals", answer: "No shared table." },
		{ category: "acceptance", answer: "A 50 MB export completes in under two minutes." },
	], open: [] };
	const plan = { activities: [], invariant: "serial",
		slices: [{ id: "s1", behavior: "the export writes one file", test: "a 1 MB export yields one file", dependsOn: [] }] };
	const boundariesPath = join(fixture.source, "boundaries.json");
	const planPath = join(fixture.source, "plan.json");
	await writeFile(boundariesPath, JSON.stringify(boundaries));
	await writeFile(planPath, JSON.stringify(plan));
	try {
		await host.prompt("/feat-flow-start desk-conv");
		const bounded = await host.prompt(`Call the tool named exactly feat_flow_request once with the single argument `
			+ `{"boundariesPath": ${JSON.stringify(boundariesPath)}}. Then stop.`);
		const planned = await host.prompt(`Call the tool named exactly feat_flow_request once with the single argument `
			+ `{"planPath": ${JSON.stringify(planPath)}}. Then stop.`);
		const write = await host.prompt("Use the write tool to create out.txt containing leaked in the current directory. Then stop.");
		const transcript = framesText(host.frames);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CONVERSATION}.json`), JSON.stringify({
			case: CONVERSATION, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			bounded: { status: bounded.status }, planned: { status: planned.status }, write: { status: write.status },
			outFile: await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CONVERSATION}.rpc.jsonl`), transcript + "\n");
		expect(transcript).toContain("open: none");
		expect(transcript).toContain("1 serial slices, 0 activities");
		expect(transcript).toContain("phase alignment");
		expect(transcript).not.toContain("approved desk-conv");
		expect(transcript).toContain("feat-flow denied this write: scope-not-approved");
		expect(await readFile(join(fixture.source, "out.txt"), "utf8").catch(() => null)).toBeNull();
		expect(host.meter.failures()).toEqual([]);
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CONVERSATION}.failure.json`), JSON.stringify({
			case: CONVERSATION, failure: error instanceof Error ? error.message : String(error),
			requests: host.meter.requests(),
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CONVERSATION}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 300_000);
