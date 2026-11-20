import type { PullRequestHandle } from "./delivery";

export interface GithubClient {
	findPullRequests(headBranch: string): Promise<PullRequestHandle[]>;
	createPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequestHandle>;
}

function gh(args: string[]): string {
	const result = Bun.spawnSync(["gh", ...args]);
	if (result.exitCode !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr.toString().slice(-400)}`);
	return result.stdout.toString();
}

/** Real GitHub through the developer's existing gh authentication; no token is read or stored here. */
export function githubClient(repository: string): GithubClient {
	return {
		async findPullRequests(headBranch) {
			const out = gh(["pr", "list", "--repo", repository, "--head", headBranch, "--state", "all", "--json", "number,url,headRefOid,body,baseRefName,state"]);
			return (JSON.parse(out) as Array<{ number: number; url: string; headRefOid: string; body: string; baseRefName: string; state: string }>)
				.map(pr => ({ number: pr.number, url: pr.url, headRefOid: pr.headRefOid, body: pr.body, base: pr.baseRefName, state: pr.state }));
		},
		async createPullRequest(input) {
			const url = gh(["pr", "create", "--repo", repository, "--head", input.head, "--base", input.base, "--title", input.title, "--body", input.body]).trim();
			const number = Number(/(\d+)\s*$/.exec(url)?.[1] ?? 0);
			if (!number) throw new Error(`gh pr create returned no pull request number: ${url.slice(0, 200)}`);
			return { number, url, headRefOid: "", body: input.body, base: input.base, state: "OPEN" };
		},
	};
}
