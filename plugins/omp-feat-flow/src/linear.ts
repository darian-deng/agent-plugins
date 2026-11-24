import { hasDeliveryMarker } from "./delivery";

export interface LinearIssue { identifier: string; state: string; hasMarker: boolean }

export interface LinearTeamSummary {
	id: string;
	key: string;
	name: string;
	states: Array<{ id: string; name: string; type: string }>;
}

export interface LinearTeamMetadata {
	viewerId: string;
	viewerName: string;
	team: LinearTeamSummary;
	labels: Array<{ id: string; name: string }>;
	projects: Array<{ id: string; name: string; milestones: Array<{ id: string; name: string }> }>;
	activeCycle: { id: string; number: number; name: string | null } | null;
}

export interface LinearCreateIssueInput {
	teamId: string;
	title: string;
	description: string;
	assigneeId?: string | undefined;
	projectId?: string | undefined;
	projectMilestoneId?: string | undefined;
	labelIds?: string[] | undefined;
	priority?: number | undefined;
	cycleId?: string | undefined;
}

export interface LinearClient {
	getIssue(identifier: string, marker: string): Promise<LinearIssue | null>;
	describe(identifier: string): Promise<{ identifier: string; state: string; teamId: string; title?: string; description?: string } | null>;
	updateIssue(identifier: string, change: { state: string; marker: string; prUrl?: string }): Promise<void>;
	fetchTeams?(): Promise<{ viewerId: string; teams: LinearTeamSummary[] }>;
	fetchTeamMetadata?(teamId: string): Promise<LinearTeamMetadata>;
	findByOriginMarker?(teamId: string, originMarker: string): Promise<Array<{ id: string; identifier: string; url: string }>>;
	createIssue?(input: LinearCreateIssueInput): Promise<{ id: string; identifier: string; url: string }>;
}

/** The key is read from the environment or the developer's keychain; it is never logged. */
export async function resolveLinearKey(): Promise<string | null> {
	if (process.env.LINEAR_API_KEY?.trim()) return process.env.LINEAR_API_KEY.trim();
	if (process.env.OMP_FEAT_FLOW_SKIP_KEYCHAIN === "1") return null;
	if (process.platform !== "darwin") return null;
	try {
		const child = Bun.spawn(["security", "find-generic-password", "-s", "omp-linear-api-key", "-w"], { stdout: "pipe", stderr: "pipe" });
		const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return code === 0 && stdout.trim() ? stdout.trim() : null;
	} catch {
		return null;
	}
}

export function linearClient(key: string): LinearClient {
	const authKey = key.trim();
	const call = async (query: string, variables: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
		const response = await fetch("https://api.linear.app/graphql", {
			method: "POST",
			headers: { Authorization: authKey, "Content-Type": "application/json" },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(15_000),
		});
		const text = await response.text();
		let payload: { data?: Record<string, unknown>; errors?: unknown } | null = null;
		try {
			payload = JSON.parse(text) as { data?: Record<string, unknown>; errors?: unknown };
		} catch {
			throw new Error(`linear ${response.status}: non-JSON response: ${text.slice(0, 300)}`);
		}
		if (!response.ok || payload.errors) throw new Error(`linear ${response.status}: ${JSON.stringify(payload.errors ?? payload).slice(0, 400)}`);
		return payload.data ?? {};
	};
	const read = async (identifier: string): Promise<{
		id: string; identifier: string; state: string; description: string; comments: string[]; teamStates: Array<{ id: string; name: string }>;
	} | null> => {
		const data = await call(
			`query($id: String!) { issue(id: $id) { id identifier state { name } description team { states(first: 100) { nodes { id name } } } comments(last: 50) { nodes { body } } } }`,
			{ id: identifier },
		) as {
			issue?: {
				id: string;
				identifier: string;
				state: { name: string };
				description?: string;
				team?: { states?: { nodes?: Array<{ id: string; name: string }> } };
				comments?: { nodes?: Array<{ body?: string }> };
			} | null;
		};
		if (!data.issue) return null;
		const comments = (data.issue.comments?.nodes ?? []).map(c => String(c.body ?? ""));
		return {
			id: data.issue.id,
			identifier: data.issue.identifier,
			state: data.issue.state.name,
			description: String(data.issue.description ?? ""),
			comments,
			teamStates: data.issue.team?.states?.nodes ?? [],
		};
	};
	return {
		async describe(identifier) {
			const data = await call(`query($id: String!) { issue(id: $id) { identifier title description state { name } team { id } } }`, { id: identifier }) as {
				issue?: { identifier: string; title?: string; description?: string; state: { name: string }; team: { id: string } } | null;
			};
			if (!data.issue) return null;
			return {
				identifier: data.issue.identifier,
				state: data.issue.state.name,
				teamId: data.issue.team.id,
				...(data.issue.title ? { title: data.issue.title } : {}),
				...(data.issue.description ? { description: data.issue.description } : {}),
			};
		},
		async getIssue(identifier, marker) {
			const issue = await read(identifier);
			if (!issue) return null;
			const hasMarker = hasDeliveryMarker(issue.description, marker)
				|| issue.comments.some(body => hasDeliveryMarker(body, marker));
			return { identifier: issue.identifier, state: issue.state, hasMarker };
		},
		async updateIssue(identifier, change) {
			const issue = await read(identifier);
			if (!issue) throw new Error(`${identifier} is not readable`);
			const stateId = issue.teamStates.find(state => state.name === change.state)?.id;
			if (!stateId) throw new Error(`the issue team has no state named ${change.state}`);
			if (issue.state !== change.state) {
				const updated = await call(
					`mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
					{ id: issue.id, input: { stateId } },
				) as { issueUpdate?: { success?: boolean } };
				if (!updated.issueUpdate?.success) throw new Error(`Linear issueUpdate did not succeed for ${identifier}`);
			}
			// Append delivery marker as an idempotent comment so concurrent human edits to issue.description are never clobbered.
			const alreadyCommented = issue.comments.some(body => hasDeliveryMarker(body, change.marker));
			if (!alreadyCommented) {
				const prSuffix = change.prUrl ? ` · PR: ${change.prUrl}` : "";
				const commentRes = await call(
					`mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
					{ input: { issueId: issue.id, body: `Delivered via \`${change.marker}\` (moved to **${change.state}**${prSuffix}).` } },
				) as { commentCreate?: { success?: boolean } };
				if (!commentRes.commentCreate?.success) throw new Error(`Linear commentCreate did not succeed for ${identifier}`);
			}
		},
		async fetchTeams() {
			const data = await call(`query { viewer { id } teams(first: 100) { nodes { id key name states(first: 100) { nodes { id name type } } } } }`) as {
				viewer?: { id?: string };
				teams?: { nodes?: Array<{ id: string; key: string; name: string; states?: { nodes?: Array<{ id: string; name: string; type: string }> } }> };
			};
			return {
				viewerId: String(data.viewer?.id ?? ""),
				teams: (data.teams?.nodes ?? []).map(t => ({
					id: String(t.id),
					key: String(t.key),
					name: String(t.name),
					states: (t.states?.nodes ?? []).map(s => ({ id: String(s.id), name: String(s.name), type: String(s.type) })),
				})),
			};
		},
		async fetchTeamMetadata(teamId) {
			const data = await call(
				`query($id: String!) {
					viewer { id name }
					team(id: $id) {
						id key name
						states(first: 100) { nodes { id name type } }
						labels(first: 100) { nodes { id name } }
						projects(first: 100, filter: { state: { nin: ["completed", "canceled"] } }) {
							nodes { id name projectMilestones(first: 100) { nodes { id name } } }
						}
						activeCycle { id number name }
					}
				}`,
				{ id: teamId },
			);
			const typed = data as {
				viewer?: { id?: string; name?: string };
				team?: {
					id: string; key: string; name: string;
					states?: { nodes?: Array<{ id: string; name: string; type: string }> };
					labels?: { nodes?: Array<{ id: string; name: string }> };
					projects?: { nodes?: Array<{ id: string; name: string; projectMilestones?: { nodes?: Array<{ id: string; name: string }> } }> };
					activeCycle?: { id: string; number: number; name?: string | null } | null;
				} | null;
			};
			const t = typed.team;
			if (!t) throw new Error(`Linear team ${teamId} not found.`);
			return {
				viewerId: String(typed.viewer?.id ?? ""),
				viewerName: String(typed.viewer?.name ?? ""),
				team: {
					id: String(t.id),
					key: String(t.key),
					name: String(t.name),
					states: (t.states?.nodes ?? []).map(s => ({ id: String(s.id), name: String(s.name), type: String(s.type) })),
				},
				labels: (t.labels?.nodes ?? []).map(l => ({ id: String(l.id), name: String(l.name) })),
				projects: (t.projects?.nodes ?? []).map(p => ({
					id: String(p.id),
					name: String(p.name),
					milestones: (p.projectMilestones?.nodes ?? []).map(m => ({ id: String(m.id), name: String(m.name) })),
				})),
				activeCycle: t.activeCycle ? { id: String(t.activeCycle.id), number: Number(t.activeCycle.number), name: t.activeCycle.name ?? null } : null,
			};
		},
		async findByOriginMarker(teamId, originMarker) {
			const data = await call(
				`query($teamId: ID!, $marker: String!) {
					issues(includeArchived: true, filter: { team: { id: { eq: $teamId } }, description: { contains: $marker } }, first: 5) {
						nodes { id identifier url }
					}
				}`,
				{ teamId, marker: originMarker },
			);
			const typed = data as { issues?: { nodes?: Array<{ id: string; identifier: string; url: string }> } };
			return (typed.issues?.nodes ?? []).map(n => ({
				id: String(n.id),
				identifier: String(n.identifier),
				url: String(n.url),
			}));
		},
		async createIssue(input) {
			const data = await call(
				`mutation($input: IssueCreateInput!) {
					issueCreate(input: $input) { success issue { id identifier url } }
				}`,
				{ input },
			);
			const typed = data as { issueCreate?: { success?: boolean; issue?: { id: string; identifier: string; url: string } | null } };
			if (!typed.issueCreate?.success || !typed.issueCreate.issue) {
				throw new Error("Linear issueCreate failed.");
			}
			return {
				id: String(typed.issueCreate.issue.id),
				identifier: String(typed.issueCreate.issue.identifier),
				url: String(typed.issueCreate.issue.url),
			};
		},
	};
}
