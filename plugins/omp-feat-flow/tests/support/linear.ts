import { tmpdir } from "node:os";

/** The developer's existing Linear key; the value is read once and never printed. */
export async function linearKey(): Promise<string> {
	if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
	const child = Bun.spawn(["security", "find-generic-password", "-s", "omp-linear-api-key", "-w"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
	const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error("no Linear key available; the live case cannot run");
	return stdout.trim();
}

export async function graphql(key: string, query: string, variables: Record<string, unknown> = {}): Promise<Record<string, any>> {
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	const payload = await response.json() as { data?: Record<string, any>; errors?: unknown };
	if (!response.ok || payload.errors) throw new Error(`linear ${response.status}: ${JSON.stringify(payload.errors ?? payload).slice(0, 600)}`);
	return payload.data ?? {};
}

export async function desktopTeamId(key: string): Promise<string> {
	const data = await graphql(key, `query { teams(filter: { key: { eq: "DESK" } }) { nodes { id } } }`);
	const id = data.teams?.nodes?.[0]?.id;
	if (!id) throw new Error("the DESK team is not visible");
	return id;
}
