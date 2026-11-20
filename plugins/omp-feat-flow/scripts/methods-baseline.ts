/**
 * Maintainer step: regenerate resources/methods-baseline.json from the audited upstream ref.
 * Runtime resolution never touches the network; it compares the installed copy to this manifest.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";

const UPDATED = new URL("../resources/methods-baseline.json", import.meta.url).pathname;
const REPO = "mattpocock/skills";
const REF = "5863806dd4e15c63174bee4e7515a4256792ecfa";
const METHODS: Record<string, string> = {
	grilling: "skills/productivity/grilling",
	tdd: "skills/engineering/tdd",
	"code-review": "skills/engineering/code-review",
};

const api = async (path: string): Promise<unknown> => {
	const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
		headers: { accept: "application/vnd.github+json", "user-agent": "omp-feat-flow-baseline" },
	});
	if (!response.ok) throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
	return response.json();
};

const tree = await api(`git/trees/${REF}?recursive=1`);
if (tree === null || typeof tree !== "object" || !("tree" in tree) || !Array.isArray(tree.tree)) throw new Error("Unexpected tree response.");
const blobs = new Map<string, number>();
for (const entry of tree.tree) {
	if (entry !== null && typeof entry === "object" && "path" in entry && "size" in entry && typeof entry.path === "string" && typeof entry.size === "number") {
		blobs.set(entry.path, entry.size);
	}
}

const methods: Record<string, { upstream: string; files: Record<string, { bytes: number; sha256: string }> }> = {};
for (const [name, directory] of Object.entries(METHODS)) {
	const files: Record<string, { bytes: number; sha256: string }> = {};
	for (const path of [...blobs.keys()].filter(path => path.startsWith(`${directory}/`)).sort()) {
		const content = await api(`contents/${path}?ref=${REF}`);
		if (content === null || typeof content !== "object" || !("content" in content) || typeof content.content !== "string") throw new Error(`No content for ${path}`);
		const bytes = Buffer.from(content.content, "base64");
		if (bytes.byteLength !== blobs.get(path)) throw new Error(`${path}: size changed between tree and contents`);
		files[path.slice(directory.length + 1)] = { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
	}
	if (Object.keys(files).length === 0) throw new Error(`${name}: no files at ${directory}`);
	methods[name] = { upstream: directory, files };
}
await writeFile(UPDATED, JSON.stringify({ schemaVersion: 1, repo: REPO, ref: REF, methods }, null, 2) + "\n");
console.log(`wrote ${Object.keys(methods).length} methods from ${REPO}@${REF.slice(0, 12)}`);
