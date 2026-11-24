import type { PullRequestHandle } from "./delivery";

export interface GithubClient {
	findPullRequests(headBranch: string): Promise<PullRequestHandle[]>;
	createPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequestHandle>;
}

async function gh(args: string[]): Promise<string> {
	const child = Bun.spawn(["gh", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`gh ${args[0]} failed: ${stderr.slice(-400)}`);
	return stdout;
}

/** Real GitHub through the developer's existing gh authentication; no token is read or stored here. */
export function githubClient(repository: string): GithubClient {
	return {
		async findPullRequests(headBranch) {
			const out = await gh([
				"pr", "list", "--repo", repository, "--head", headBranch, "--state", "all",
				"--json", "number,url,headRefOid,body,baseRefName,state,isCrossRepository",
			]);
			return (JSON.parse(out) as Array<{
				number: number; url: string; headRefOid: string; body: string; baseRefName: string; state: string; isCrossRepository?: boolean;
			}>).map(pr => ({
				number: pr.number,
				url: pr.url,
				headRefOid: pr.headRefOid,
				body: pr.body,
				base: pr.baseRefName,
				state: pr.state,
				...(pr.isCrossRepository !== undefined ? { isCrossRepository: pr.isCrossRepository } : {}),
			}));
		},
		async createPullRequest(input) {
			const url = (await gh([
				"pr", "create", "--repo", repository, "--head", input.head, "--base", input.base, "--title", input.title, "--body", input.body,
			])).trim();
			const number = Number(/(\d+)\s*$/.exec(url)?.[1] ?? 0);
			if (!number) throw new Error(`gh pr create returned no pull request number: ${url.slice(0, 200)}`);
			return { number, url, headRefOid: "", body: input.body, base: input.base, state: "OPEN", isCrossRepository: false };
		},
	};
}
