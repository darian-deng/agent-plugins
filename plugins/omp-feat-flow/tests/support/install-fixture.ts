import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export interface InstallFixture {
	root: string;
	catalog: string;
	profile: string;
	pluginDir: string;
	/** Install (or upgrade to) the given version and return the cli output. */
	install(version: string, marker: string): Promise<string>;
	installedRelease(): Promise<{ buildId: string; version: string } | null>;
	cleanup(): Promise<void>;
}

/**
 * A real local Git catalog plus a dedicated native profile: the plugin is installed through the
 * ordinary native path, with no developer node_modules or compiler inside the installed tree.
 */
export interface InstallFixtureOptions {
	/** Reuse a live profile so the plugin installs where the native host will look for it. */
	profile?: { agentDir: string; home: string };
	/** The profile's own environment (credential blanking included) is the only source of truth here. */
	env?: Record<string, string>;
}

export async function installFixture(options: InstallFixtureOptions = {}): Promise<InstallFixture> {
	const root = await mkdtemp(join(tmpdir(), "omp-feat-install-"));
	const catalog = join(root, "catalog");
	const plugins = join(catalog, "plugins");
	const pluginDir = join(plugins, "omp-feat-flow");
	const profile = options.profile?.agentDir ?? join(root, "agent");
	const home = options.profile?.home ?? join(root, "home");
	await mkdir(plugins, { recursive: true });
	await mkdir(profile, { recursive: true, mode: 0o700 });
	await mkdir(home, { recursive: true, mode: 0o700 });

	const cli = join(PACKAGE, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
	const env = { ...(options.env ?? process.env), PI_CODING_AGENT_DIR: profile, HOME: home, PI_NOTIFICATIONS: "off", NO_COLOR: "1" };

	const run = async (args: string[]): Promise<string> => {
		const child = Bun.spawn([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe", cwd: root });
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
		]);
		if (code !== 0) throw new Error(`omp ${args.join(" ")} failed (${code}): ${(stderr || stdout).slice(-2000)}`);
		return stdout + stderr;
	};

	// Build a release on the side, then install only the artifact.
	const build = async (version: string, marker: string): Promise<void> => {
		await rm(pluginDir, { recursive: true, force: true });
		await mkdir(join(pluginDir, "scripts"), { recursive: true });
		await mkdir(join(pluginDir, "resources"), { recursive: true });
		await cp(join(PACKAGE, "src"), join(pluginDir, "src"), { recursive: true });
		await cp(join(PACKAGE, "resources"), join(pluginDir, "resources"), { recursive: true });
		await cp(join(PACKAGE, "scripts", "build.ts"), join(pluginDir, "scripts", "build.ts"));
		await cp(join(PACKAGE, "tsconfig.json"), join(pluginDir, "tsconfig.json"));
		// Build-time only: the published artifact never keeps a node_modules link.
		await symlink(join(PACKAGE, "node_modules"), join(pluginDir, "node_modules"));
		const pkg = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8")) as Record<string, unknown>;
		pkg.version = version;
		delete pkg.dependencies;
		delete pkg.devDependencies;
		delete pkg.scripts;
		delete pkg.files;
		await writeFile(join(pluginDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
		await writeFile(join(pluginDir, "resources", "build-marker.txt"), `${marker}\n`);
		// The exact same build script the developer uses.
		const built = Bun.spawnSync([process.execPath, "scripts/build.ts"], { cwd: pluginDir, env });
		if (built.exitCode !== 0) throw new Error(`fixture build failed: ${built.stderr.toString().slice(-2000)}`);
		// A published package never ships sources or a compiler.
		await rm(join(pluginDir, "src"), { recursive: true, force: true });
		await rm(join(pluginDir, "scripts"), { recursive: true, force: true });
		await rm(join(pluginDir, "node_modules"), { force: true });
	};

	return {
		root, catalog, profile, pluginDir,
		async install(version, marker) {
			await build(version, marker);
			const manifest = { name: "darian-omp-plugins", owner: { name: "fixture" },
				plugins: [{ name: "omp-feat-flow", source: "./plugins/omp-feat-flow", version }] };
			await mkdir(join(catalog, ".omp-plugin"), { recursive: true });
			await writeFile(join(catalog, ".omp-plugin", "marketplace.json"), JSON.stringify(manifest, null, 2) + "\n");
			await run(["plugin", "marketplace", "add", catalog]).catch(async error => {
				// Already registered from an earlier version in this fixture.
				if (!String(error).includes("already")) throw error;
			});
			return run(["plugin", "install", "omp-feat-flow@darian-omp-plugins", "--scope", "user", "--force"]);
		},
		async installedRelease() {
			const listed = await run(["plugin", "list", "--json"]).catch(() => "");
			const paths = [...listed.matchAll(/"installPath"\s*:\s*"([^"]+)"/g)].map(match => match[1]!);
			const target = paths.at(-1);
			if (!target) return null;
			try {
				return JSON.parse(await readFile(join(target, "runtime", "release.json"), "utf8")) as { buildId: string; version: string };
			} catch {
				return null;
			}
		},
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}
