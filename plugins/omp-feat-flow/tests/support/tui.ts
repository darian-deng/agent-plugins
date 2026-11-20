import { join } from "node:path";
import { tmpdir } from "node:os";

export interface TuiStep { afterMs: number; text: string }

/** Drives the real native TUI in a PTY and returns the ANSI-stripped screen transcript. */
export async function driveTui(input: {
	profile: string; home: string; cwd: string; steps: TuiStep[]; totalMs?: number;
	/** Extra environment (a metered provider, a skills directory); inherited variables stay available. */
	env?: Record<string, string>;
	model?: string;
	/** The child's working directory; `cwd` only locates the CLI and its node_modules. */
	workdir?: string;
}): Promise<string> {
	const driver = new URL("./tui_driver.py", import.meta.url).pathname;
	const child = Bun.spawn(["/usr/bin/python3", driver, "--profile", input.profile, "--home", input.home,
		"--cwd", input.cwd, "--steps", JSON.stringify(input.steps), "--total", String(input.totalMs ?? 30_000),
		"--env", JSON.stringify(input.env ?? {}), "--model", input.model ?? "", "--workdir", input.workdir ?? ""],
		{ cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`tui driver failed (${code}): ${stderr.slice(-500)}`);
	const parsed = JSON.parse(stdout) as { screen: string };
	return parsed.screen;
}

export const TUI_CLI_DIR = new URL("../..", import.meta.url).pathname;
