import { hasDeliveryMarker } from "./delivery";

export interface LinearIssue { identifier: string; state: string; hasMarker: boolean }

export interface LinearClient {
	getIssue(identifier: string, marker: string): Promise<LinearIssue | null>;
	/** The issue's own identity and team, for validating a binding before any work starts. */
	describe(identifier: string): Promise<{ identifier: string; state: string; teamId: string } | null>;
	updateIssue(identifier: string, change: { state: string; marker: string }): Promise<void>;
}

/** The key is read from the environment or the developer's keychain; it is never logged. */
export async function resolveLinearKey(): Promise<string | null> {
	if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
	const child = Bun.spawn(["security", "find-generic-password", "-s", "omp-linear-api-key", "-w"], { stdout: "pipe", stderr: "pipe" });
	const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return code === 0 && stdout.trim() ? stdout.trim() : null;
}

export function linearClient(key: string): LinearClient {
	const call = async (query: string, variables: Record<string, unknown> = {}): Promise<Record<string, any>> => {
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST", headers: { Authorization: key, "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
		});
		const payload = await response.json() as { data?: Record<string, any>; errors?: unknown };
		if (!response.ok || payload.errors) throw new Error(`linear ${response.status}: ${JSON.stringify(payload.errors ?? payload).slice(0, 400)}`);
		return payload.data ?? {};
	};
	const read = async (identifier: string): Promise<{ id: string; identifier: string; state: string; description: string } | null> => {
		const data = await call(`query($id: String!) { issue(id: $id) { id identifier state { name } description } }`, { id: identifier });
		if (!data.issue) return null;
		return { id: data.issue.id, identifier: data.issue.identifier, state: data.issue.state.name, description: String(data.issue.description ?? "") };
	};
	return {
		async describe(identifier) {
			const data = await call(`query($id: String!) { issue(id: $id) { identifier state { name } team { id } } }`, { id: identifier });
			if (!data.issue) return null;
			return { identifier: data.issue.identifier, state: data.issue.state.name, teamId: data.issue.team.id };
		},
		async getIssue(identifier, marker) {
			const issue = await read(identifier);
			if (!issue) return null;
			return { identifier: issue.identifier, state: issue.state, hasMarker: hasDeliveryMarker(issue.description, marker) };
		},
		async updateIssue(identifier, change) {
			const issue = await read(identifier);
			if (!issue) throw new Error(`${identifier} is not readable`);
			// States are team-scoped; a global name match can belong to another team and is rejected by the server.
			const states = (await call(`query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`, { id: issue.id }))
				.issue.team.states.nodes as Array<{ id: string; name: string }>;
			const stateId = states.find(state => state.name === change.state)?.id;
			if (!stateId) throw new Error(`the issue team has no state named ${change.state}`);
			await call(`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
				{ id: issue.id, input: { stateId, description: `${issue.description}\n\n${change.marker}` } });
		},
	};
}
