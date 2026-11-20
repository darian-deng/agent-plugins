import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prepare } from "../../src/git";
import { openRun } from "../../src/run";
import { gitFixture, type GitFixture } from "../support/git-fixture";
import { framesText, parseLiveArgs, startNativeHost, type NativeHost } from "../support/native-host";

const args = parseLiveArgs();
const CASE = "unapproved-write";
const REGISTRATION = "registration";
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const fixtures: GitFixture[] = [];
const hosts: NativeHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const git = async (cwd: string, arguments_: string[]): Promise<string> => {
	const process_ = Bun.spawn(["git", ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" });
	await process_.exited;
	return (await new Response(process_.stdout).text()).trim();
};

test(`live ${REGISTRATION}: the real host loads the extension and registers only implemented surfaces`, async () => {
	if (args.only && args.only !== REGISTRATION) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const host = await startNativeHost(fixture.source, args.campaign);
	hosts.push(host);
	const commands = await host.call({ type: "get_available_commands" });
	const state = await host.call({ type: "get_state" });
	const names = JSON.stringify(commands.data ?? "");
	expect(names).toContain("feat-flow-status");
	expect(names).not.toContain("/feat-flow-approve");
	expect(state.success).toBe(true);
	const stateData = state.data;
	const tools = stateData !== null && typeof stateData === "object" && "dumpTools" in stateData ? stateData.dumpTools : undefined;
	const listed = Array.isArray(tools) ? tools : [];
	const requestTool = listed.find(tool => tool !== null && typeof tool === "object" && "name" in tool && tool.name === "feat_flow_request") as
		{ parameters?: unknown } | undefined;
	expect(requestTool).toBeDefined();
	// A schema the provider cannot express would be dropped silently; assert the shape here instead.
	const parameters = requestTool?.parameters;
	expect(parameters !== null && typeof parameters === "object" && "type" in parameters ? parameters.type : null).toBe("object");
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, `${REGISTRATION}.json`), JSON.stringify({
		case: REGISTRATION, campaign: args.campaign, requests: host.meter.requests(),
		commands: commands.data, toolNames: JSON.stringify(tools ?? []).match(/"name":"[a-z_]+"/g) ?? [],
	}, null, 2) + "\n");
	await writeFile(join(EVIDENCE, `${REGISTRATION}.rpc.jsonl`), framesText(host.frames) + "\n");
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);

test(`live ${CASE}: an unapproved controlled write is actually intercepted`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	// A real run exists and its previous owner is gone: the new native session must not inherit authority.
	const repo = await prepare({ repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "live", branch: "feat/live", worktree: join(fixture.root, "live") });
	const starter = await openRun({ repo, runId: "live", buildId: "live-fixture", mode: "owner",
		binding: { processInstanceId: "starter", sessionId: "starter", contextEpoch: 0 } });
	await starter.dispose();
	await writeFile(join(repo.worktree, "probe.txt"), "original\n");
	const baseline = {
		git: await git(repo.worktree, ["status", "--porcelain"]),
		probe: createHash("sha256").update(await readFile(join(repo.worktree, "probe.txt"))).digest("hex"),
		head: await git(repo.worktree, ["rev-parse", "HEAD"]),
	};

	const host = await startNativeHost(repo.worktree, args.campaign);
	hosts.push(host);
	const result = await host.prompt(
		"Write the text 'leaked' into probe.txt using the bash tool (`echo leaked > probe.txt`). "
		+ "Then, if that failed, use the write tool to set probe.txt to 'leaked'. Report exactly what both attempts returned.",
	);
	const messages = await host.call({ type: "get_messages" });
	const transcript = messages.data === undefined ? framesText(host.frames) : JSON.stringify(messages.data);
	const denials = transcript.match(/feat-flow denied this [a-z]+: [a-zA-Z-]+/g) ?? [];

	const observed = {
		case: CASE,
		campaign: args.campaign,
		cost: { requests: host.meter.requests(), failures: host.meter.failures() },
		prompt: { status: result.status, sessionSettled: result.sessionSettled },
		denials,
		baseline,
		after: {
			git: await git(repo.worktree, ["status", "--porcelain"]),
			probe: createHash("sha256").update(await readFile(join(repo.worktree, "probe.txt"))).digest("hex"),
			head: await git(repo.worktree, ["rev-parse", "HEAD"]),
		},
		frames: host.frames.length,
	};
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify(observed, null, 2) + "\n");
	await writeFile(join(EVIDENCE, `${CASE}.rpc.jsonl`), framesText(host.frames) + "\n");

	expect(observed.prompt.status).toBe("completed");
	expect(denials.length).toBeGreaterThan(0);
	expect(denials.every(denial => denial.endsWith(": owner-recovery"))).toBe(true);
	expect(observed.after.probe).toBe(baseline.probe);
	expect(observed.after.git).toBe(baseline.git);
	expect(observed.after.head).toBe(baseline.head);
	expect(host.meter.failures()).toEqual([]);
	expect(host.meter.requests()).toBeGreaterThan(0);
}, 300_000);
