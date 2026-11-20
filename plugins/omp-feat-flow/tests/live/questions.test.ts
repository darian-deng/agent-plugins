import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { seedProject } from "../support/project";
import { approvalPacket, coldReadPrompt, renderPacket } from "../../src/questions";
import { framesText, parseLiveArgs, startIsolatedProfile, startNativeHost, type IsolatedProfile, type NativeHost } from "../support/native-host";

const CASE = "question-approval";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const fixtures: GitFixture[] = [];
const hosts: NativeHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const RUNNER = new URL("../support/helper-runner.ts", import.meta.url).pathname;
// The positive cases use the developer's real installed methods; the isolated HOME has none.
const INSTALLED_SKILLS = { OMP_FEAT_FLOW_SKILLS_DIR: join(homedir(), ".agents", "skills") };

async function runColdRead(packet: ReturnType<typeof approvalPacket>, profile: IsolatedProfile): Promise<{ text: string; tools: string[] }> {
	const job = { kind: "cold-read", cwd: process.cwd(), prompt: coldReadPrompt(packet),
		binding: { taskId: "question-packet", epoch: 1, snapshotDigest: packet.id } };
	const child = Bun.spawn([process.execPath, RUNNER, JSON.stringify(job)], { env: profile.env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	if (exitCode !== 0) throw new Error(`cold reader failed (${exitCode}): ${stderr.slice(-2000)}`);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { text: string; tools: string[] };
}

async function answerNextConfirm(host: NativeHost, confirmed: boolean): Promise<{ title: unknown; message: unknown }> {
	const frame = await host.next(item => item.type === "extension_ui_request" && item.method === "confirm", "native confirm", 120_000);
	host.send({ type: "extension_ui_response", id: frame.id, confirmed });
	return { title: frame.title, message: frame.message };
}

test(`live ${CASE}: cancelling a native approval keeps implementation closed`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	try {
	const started = await host.prompt("/feat-flow-start desk-live");
	const proposal = await host.prompt(
		"Call the tool named exactly feat_flow_request once with arguments "
		+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. '
		+ "Do not write any file, do not read any file. Then stop.",
	);
	const approving = host.startPrompt("/feat-flow-approve");
	const shown = await answerNextConfirm(host, false);
	const approveResult = await approving.result;
	const writeAttempt = await host.prompt("Use the write tool to set probe.txt to 'approved'. Then stop.");

	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		case: CASE, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
		started: { status: started.status, agentInvoked: started.agentInvoked },
		proposal: { status: proposal.status, agentInvoked: proposal.agentInvoked },
		confirm: shown,
		approve: { status: approveResult.status },
		writeAttempt: { status: writeAttempt.status },
		probe: await readFile(join(fixture.source, "probe.txt"), "utf8").catch(() => null),
	}, null, 2) + "\n");
	await writeFile(join(EVIDENCE, `${CASE}.rpc.jsonl`), framesText(host.frames) + "\n");

	const transcript = framesText(host.frames);
	expect(transcript).toContain("Cancelled: implementation stays closed");
	expect(transcript).not.toContain("approved desk-live revision");
	expect(transcript).toContain("scope-not-approved");
	expect(await readFile(join(fixture.source, "probe.txt"), "utf8").catch(() => null)).toBeNull();
	expect(host.meter.failures()).toEqual([]);
	} catch (error) {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CASE}.failure.json`), JSON.stringify({
			case: CASE, failure: error instanceof Error ? error.message : String(error),
			requests: host.meter.requests(), meterFailures: host.meter.failures(), frames: host.frames.length,
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${CASE}.failure.rpc.jsonl`), framesText(host.frames) + "\n");
		throw error;
	}
}, 300_000);

const PACKET_CASE = "question-packet";

test(`live ${PACKET_CASE}: a cold reader answers the packet the native confirm actually shows`, async () => {
	if (args.only && args.only !== PACKET_CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	const profile = host.profile;
	try {
		await host.prompt("/feat-flow-start desk-packet");
		await host.prompt(
			"Call the tool named exactly feat_flow_request once with arguments "
			+ '{"proposalContent": "Add a probe line to probe.txt.", "proposalScope": "probe.txt only"}. '
			+ "Do not write any file, do not read any file. Then stop.",
		);
		const state = JSON.parse(await readFile(join(fixture.source, ".git", "omp-feat-flow", "runs", "desk-packet", "state.json"), "utf8")) as {
			candidate: { contentPath: string; revision: number; digest: string } | null;
			currentIntegrationSha: string;
		};
		if (!state.candidate) throw new Error("The proposal did not reach the run.");
		const material = JSON.parse(await readFile(state.candidate.contentPath, "utf8")) as { content: string; scope: string };
		const packet = approvalPacket({ runId: "desk-packet", candidateRevision: state.candidate.revision,
			content: material.content, scope: material.scope, base: state.currentIntegrationSha });
		const cold = await runColdRead(packet, profile);
		const approving = host.startPrompt("/feat-flow-approve");
		const shown = await answerNextConfirm(host, true);
		const approveResult = await approving.result;
		// The approval must actually open the approved scope for a real write.
		const write = await host.prompt("Use the write tool to create a file named probe.txt in the current directory containing the word approved. Then stop.");
		const written = await readFile(join(fixture.source, "probe.txt"), "utf8").catch(() => null);
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${PACKET_CASE}.json`), JSON.stringify({
			case: PACKET_CASE, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
			packetId: packet.id, cold, shown, approve: { status: approveResult.status },
			write: { status: write.status }, written,
		}, null, 2) + "\n");
		await writeFile(join(EVIDENCE, `${PACKET_CASE}.rpc.jsonl`), framesText(host.frames) + "\n");
		const transcript = framesText(host.frames);
		expect(cold.text).toContain("ANSWERABLE");
		expect(cold.text).toContain("approve");
		expect(String(shown.message)).toContain("Permits implementation writes inside the stated scope");
		expect(String(shown.message)).toContain("does not permit merge, publication or delivery");
		expect(transcript).toContain("approved desk-packet revision");
		expect(written).toContain("approved");
		expect(host.meter.failures()).toEqual([]);
	} finally {
		profile.stop();
	}
}, 400_000);

test("live controller-persistence: the run created by start survives a later command", async () => {
	if (args.only && args.only !== "controller-persistence") return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: INSTALLED_SKILLS });
	hosts.push(host);
	const started = await host.prompt("/feat-flow-start desk-persist");
	const status = await host.prompt("/feat-flow-status");
	const transcript = framesText(host.frames);
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, "controller-persistence.json"), JSON.stringify({
		case: "controller-persistence", campaign: args.campaign, requests: host.meter.requests(),
		started: { status: started.status }, status: { status: status.status },
	}, null, 2) + "\n");
	await writeFile(join(EVIDENCE, "controller-persistence.rpc.jsonl"), transcript + "\n");
	expect(transcript).toContain("run desk-persist created");
	expect(transcript).toContain("run desk-persist r");
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);
