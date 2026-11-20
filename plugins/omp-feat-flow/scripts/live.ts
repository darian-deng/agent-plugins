/** `npm run test:live -- --campaign <id> [--case <name>]`: bun test drops unknown flags, so forward them as env. */
const argv = process.argv.slice(2);
const flag = (name: string): string | null => {
	const index = argv.indexOf(name);
	return index >= 0 ? (argv[index + 1] ?? null) : null;
};
const campaign = flag("--campaign");
const only = flag("--case");
if (!campaign || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(campaign)) {
	console.error("usage: npm run test:live -- --campaign <id> [--case <name>]");
	process.exit(2);
}
const args = ["test", "tests/live"];
if (only) args.push("-t", `^live ${only}:`);
const child = Bun.spawn([process.execPath, ...args], {
	cwd: new URL("..", import.meta.url).pathname,
	stdio: ["inherit", "inherit", "inherit"],
	env: { ...process.env, FEAT_FLOW_CAMPAIGN: campaign, FEAT_FLOW_CASE: only ?? "" },
});
process.exit(await child.exited);
