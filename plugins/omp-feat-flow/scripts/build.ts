import { build, version as esbuildVersion } from "esbuild";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
// CI rebuilds into a temporary tree and compares against the committed artifact.
const outdir = process.env.OMP_FEAT_FLOW_OUTDIR ?? join(root, "runtime");

async function fingerprint(): Promise<string> {
	const files: string[] = ["package.json", "tsconfig.json", "scripts/build.ts"];
	// A published artifact need not ship a lockfile; its identity then omits it.
	if (await readFile(join(root, "package-lock.json")).then(() => true).catch(() => false)) files.push("package-lock.json");
	const walk = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) files.push(relative(root, path));
		}
	};
	await walk(join(root, "src"));
	await walk(join(root, "resources"));
	const hash = createHash("sha256");
	for (const file of files.sort()) {
		hash.update(file);
		hash.update("\0");
		hash.update(await readFile(join(root, file)));
		hash.update("\0");
	}
	// Tool identity, not timestamps or absolute paths.
	const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
	};
	const sdk = (pkg.devDependencies ?? pkg.dependencies)?.["@oh-my-pi/pi-coding-agent"] ?? "unpinned";
	hash.update(`esbuild:${esbuildVersion}\0bun:${Bun.version}\0sdk:${sdk}`);
	return hash.digest("hex");
}

const buildId = await fingerprint();
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
	version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
};
const sdkVersion = (pkg.devDependencies ?? pkg.dependencies)?.["@oh-my-pi/pi-coding-agent"] ?? "unpinned";

const result = await build({
	entryPoints: [join(root, "src/index.ts")],
	outfile: join(outdir, "index.mjs"),
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22",
	legalComments: "none",
	external: ["@oh-my-pi/*"],
	define: {
		"process.env.OMP_FEAT_FLOW_BUILD_ID": JSON.stringify(buildId),
		"process.env.OMP_FEAT_FLOW_VERSION": JSON.stringify(pkg.version),
	},
	logLevel: "warning",
});

await mkdir(outdir, { recursive: true });
const bytes = await readFile(join(outdir, "index.mjs"));
const release = {
	schemaVersion: 1,
	version: pkg.version,
	buildId,
	bundleBytes: bytes.byteLength,
	bundleSha256: createHash("sha256").update(bytes).digest("hex"),
	tools: { esbuild: esbuildVersion, bun: Bun.version, sdk: sdkVersion },
	// Executable resources stay out of the manifest; only identities and facts are recorded.
	capabilities: ["commands", "tool-call-admission", "request-outbox", "workspace", "sync", "delivery"],
};
await writeFile(join(outdir, "release.json"), JSON.stringify(release, null, 2) + "\n");
for (const output of result.outputFiles ?? []) void output;
console.log(`runtime/index.mjs ${release.bundleBytes} bytes build ${buildId.slice(0, 12)} v${pkg.version}`);
