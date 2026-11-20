var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { readFile as readFile3 } from "node:fs/promises";

// src/flow.ts
import { createHash as createHash5 } from "node:crypto";
import { existsSync, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { mkdir as mkdir3, stat as statPath } from "node:fs/promises";
import { resolve as resolve4 } from "node:path";

// src/reconcile.ts
function reconcileInterruptedSync(input) {
  if (input.rebasing) return { kind: "blocked", reason: "rebase-in-progress" };
  if (input.porcelain.trim()) return { kind: "blocked", reason: "foreign-changes" };
  if (input.head === input.integrationSha) return { kind: "reclaim", reason: "clean-tree" };
  if (input.baseSha && input.headDescendsFromBase) return { kind: "applied", head: input.head };
  return { kind: "blocked", reason: "head-moved" };
}

// src/knowledge.ts
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
function lines(text) {
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
function lineDiff(before, after) {
  const diff = [];
  const max = Math.max(before.length, after.length);
  for (let index = 0; index < max; index += 1) {
    const old = before[index];
    const next = after[index];
    if (old === next) continue;
    if (old !== void 0) diff.push(`-${old}`);
    if (next !== void 0) diff.push(`+${next}`);
  }
  return diff;
}
async function proposeKnowledge(request) {
  if (request.candidates.length === 0) {
    return { change: false, reason: "Nothing in the current project knowledge is contradicted by observed evidence.", changes: [] };
  }
  const root = resolve(request.root);
  const changes = [];
  for (const candidate of request.candidates) {
    if (!candidate.reason.trim()) throw new Error(`${candidate.path}: a knowledge correction needs its concrete reason.`);
    const target = resolve(join(root, candidate.path));
    if (!target.startsWith(root + "/")) throw new Error(`${candidate.path} escapes the project root.`);
    const existing = await readFile(target, "utf8").catch(() => null);
    if (existing === candidate.proposed) continue;
    const diff = existing === null ? lines(candidate.proposed).map((line) => `+${line}`) : lineDiff(lines(existing), lines(candidate.proposed));
    if (diff.length === 0) continue;
    changes.push({ path: relative(root, target), status: existing === null ? "created" : "modified", diff });
  }
  if (changes.length === 0) {
    return { change: false, reason: "The proposed content already matches the existing files; no correction is warranted.", changes: [] };
  }
  return { change: true, reason: `${changes.length} file(s) would change; the diff needs explicit approval.`, changes };
}

// src/flow.ts
import { isAbsolute, join as join4 } from "node:path";

// resources/methods.json
var methods_default = {
  schemaVersion: 1,
  core: [
    "grilling",
    "tdd",
    "code-review"
  ],
  conditional: [
    "research",
    "prototype",
    "codebase-design",
    "to-spec",
    "to-tickets",
    "wizard",
    "wayfinder",
    "diagnosing-bugs",
    "to-questionnaire",
    "domain-modeling",
    "retro"
  ],
  skillsCli: "npx skills add mattpocock/skills --skill grilling tdd code-review --global --agent pi",
  pluginInstall: "omp plugin marketplace add mattpocock/skills && omp plugin install mattpocock-skills@mattpocock --scope user",
  pluginSkillCount: 27,
  conditionalRef: "abeeaf95660ba9e8b7c753eb38f441ca707a8823",
  alignment: "grill-with-docs",
  maintenance: "retro",
  preflight: "setup-matt-pocock-skills"
};

// src/git.ts
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { resolve as resolve2 } from "node:path";
import { promisify } from "node:util";
var execute = promisify(execFile);
async function git(cwd, args) {
  const { stdout } = await execute("git", args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 1024 * 1024
  });
  return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
}
async function prepare(input) {
  const repo = await realpath(await git(input.repo, ["rev-parse", "--show-toplevel"]));
  const commonDir = await realpath(await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const worktree = resolve2(repo, input.worktree);
  const existing = await lstat(worktree).catch((error) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("The requested worktree path already exists and is not adopted.");
  const privateStartRef = `refs/omp-feat-flow/start/${input.runId}`;
  const start = input.startRef.startsWith(`${input.remote}/`) ? input.startRef.slice(input.remote.length + 1) : input.startRef;
  const sourceRef = start.startsWith("refs/heads/") ? start : `refs/heads/${start}`;
  await git(repo, ["check-ref-format", "--branch", input.branch]);
  await git(repo, ["check-ref-format", sourceRef]);
  await git(repo, ["check-ref-format", privateStartRef]);
  if (await git(repo, ["for-each-ref", "--format=%(refname)", privateStartRef, `refs/heads/${input.branch}`])) {
    throw new Error("This run or branch already exists; reconcile it instead of preparing again.");
  }
  try {
    await git(repo, ["fetch", "--no-tags", "--no-write-fetch-head", "--", input.remote, `${sourceRef}:${privateStartRef}`]);
    const startSha2 = await git(repo, ["rev-parse", "--verify", `${privateStartRef}^{commit}`]);
    await git(repo, ["worktree", "add", "-b", input.branch, "--", worktree, startSha2]);
  } catch (error) {
    await git(repo, ["update-ref", "-d", privateStartRef]).catch(() => {
    });
    throw error;
  }
  const startSha = await git(repo, ["rev-parse", "--verify", `${privateStartRef}^{commit}`]);
  const worktreeGitDir = await realpath(await git(worktree, ["rev-parse", "--absolute-git-dir"]));
  return {
    runId: input.runId,
    repo,
    repoIdentity: commonDir,
    commonDir,
    worktree: await realpath(worktree),
    worktreeGitDir,
    branch: input.branch,
    remote: input.remote,
    prBase: input.prBase,
    startSha,
    currentIntegrationSha: startSha,
    privateStartRef
  };
}
async function inspectRepository(cwd) {
  const repo = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  const commonDir = await realpath(await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const worktreeGitDir = await realpath(await git(repo, ["rev-parse", "--absolute-git-dir"]));
  const branch = await git(repo, ["branch", "--show-current"]);
  return { repo, repoIdentity: commonDir, commonDir, worktreeGitDir, branch: branch || null };
}
async function sync(input) {
  const { repo } = input;
  const baseRef = `refs/feat-flow/${repo.runId}/base`;
  const result = {
    outcome: "unknown",
    startSha: repo.startSha,
    previousIntegrationSha: repo.currentIntegrationSha,
    newIntegrationSha: repo.currentIntegrationSha,
    baseRef,
    detail: ""
  };
  try {
    await git(repo.repo, ["fetch", "--no-tags", repo.remote, `+refs/heads/${repo.prBase}:${baseRef}`]);
  } catch (error) {
    return { ...result, detail: `fetch failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  const base = await git(repo.repo, ["rev-parse", `${baseRef}^{commit}`]).catch(() => "");
  if (!base) return { ...result, detail: "the fetched base ref is unreadable" };
  if (base === repo.currentIntegrationSha) return { ...result, outcome: "unchanged", detail: "the review base already matches" };
  const dirty = await git(repo.worktree, ["status", "--porcelain"]);
  if (dirty.trim()) return { ...result, outcome: "foreign-dirt", detail: "the worktree has changes this sync does not own" };
  try {
    await git(repo.worktree, ["rebase", base]);
  } catch (error) {
    const inProgress = await git(repo.worktree, ["rev-parse", "--git-path", "rebase-merge"]).catch(() => "");
    const unmerged = await git(repo.worktree, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
    return {
      ...result,
      outcome: "conflict",
      detail: `rebase stopped (${inProgress ? "rebase in progress" : "no rebase recorded"}); unmerged: ${unmerged.trim() || "none"}. ${error instanceof Error ? error.message.slice(0, 200) : ""}`
    };
  }
  const head = await git(repo.worktree, ["rev-parse", "HEAD"]);
  const contains = await git(repo.worktree, ["merge-base", "--is-ancestor", base, "HEAD"]).then(() => true).catch(() => false);
  if (!contains) return { ...result, outcome: "unknown", detail: "the rebase did not place the feature on the new base" };
  return {
    ...result,
    outcome: "synced",
    newIntegrationSha: base,
    detail: `rebased onto ${base.slice(0, 12)}; feature head ${head.slice(0, 12)}`
  };
}

// src/methods.ts
import { createHash } from "node:crypto";
import { readdir, readFile as readFile2, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join as join2, relative as relative2 } from "node:path";

// resources/methods-baseline.json
var methods_baseline_default = {
  schemaVersion: 1,
  repo: "mattpocock/skills",
  ref: "5863806dd4e15c63174bee4e7515a4256792ecfa",
  methods: {
    grilling: {
      upstream: "skills/productivity/grilling",
      files: {
        "SKILL.md": {
          bytes: 2077,
          sha256: "a146842ed93ca43d833550fa9adf02e58cb63c83fea9d4b4522995b82242d4e2"
        },
        "agents/openai.yaml": {
          bytes: 113,
          sha256: "1411d7df7d99b7e621a1ff8283c8133cc2464be63d064e52d8ce169c6800ee9b"
        }
      }
    },
    tdd: {
      upstream: "skills/engineering/tdd",
      files: {
        "SKILL.md": {
          bytes: 3629,
          sha256: "5505d25bbaa8fc14a79e4d20163936958992a2995b7f1dd1d6197edc9ed722e0"
        },
        "agents/openai.yaml": {
          bytes: 87,
          sha256: "ea6f01cf1b8c06a4b0f5b649d74b1b8ce8685e72af1b38d70d877693e092af0b"
        },
        "mocking.md": {
          bytes: 1481,
          sha256: "3ceb807fdf4a47d6a93d4d9a891e5ba6d362a6247bd08adc451feebfc17361ef"
        },
        "tests.md": {
          bytes: 2214,
          sha256: "859f9e592c188fda4fc7277dd180e4ce9c7a2e13f6efe1f6f29eccc9d28c106a"
        }
      }
    },
    "code-review": {
      upstream: "skills/engineering/code-review",
      files: {
        "SKILL.md": {
          bytes: 6721,
          sha256: "9c921a8d88138a41401d8897ca1bb852088ab1b7b605cdd04edc13e3e8aab6dd"
        },
        "agents/openai.yaml": {
          bytes: 100,
          sha256: "8229ca854e11dc8e6aef2131ee03f31fb1561cf905fab9ccc325180cf3331352"
        }
      }
    }
  }
};

// src/methods.ts
var BASELINE = methods_baseline_default;
function methodsRoot() {
  return process.env.OMP_FEAT_FLOW_SKILLS_DIR || join2(homedir(), ".agents", "skills");
}
async function listFiles(directory) {
  const found = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join2(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) found.push(relative2(directory, path));
    }
  };
  if (!(await stat(directory).catch(() => null))?.isDirectory()) return [];
  await walk(directory);
  return found.sort();
}
async function resolveMethods(names, root = methodsRoot()) {
  const methods = [];
  for (const name of names) {
    const expected = BASELINE.methods[name];
    const directory = join2(root, name);
    const files = [];
    for (const path of await listFiles(directory)) {
      const bytes = await readFile2(join2(directory, path));
      files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    const present = new Set(files.map((file) => file.path));
    if (!expected) {
      methods.push({
        name,
        directory,
        upstream: null,
        status: files.length === 0 ? "missing" : "unknown-source",
        files,
        missingFiles: [],
        extraFiles: [],
        changedFiles: [],
        update: { permitted: false, reason: "No audited upstream baseline is recorded for this method." }
      });
      continue;
    }
    const expectedPaths = Object.keys(expected.files);
    const missingFiles = expectedPaths.filter((path) => !present.has(path));
    const extraFiles = files.map((file) => file.path).filter((path) => !(path in expected.files));
    const changedFiles = files.filter((file) => {
      const audited = expected.files[file.path];
      return audited !== void 0 && audited.sha256 !== file.sha256;
    }).map((file) => file.path);
    const status = files.length === 0 ? "missing" : missingFiles.length > 0 ? "incomplete" : changedFiles.length > 0 || extraFiles.length > 0 ? "modified" : "audited-match";
    methods.push({
      name,
      directory,
      upstream: expected.upstream,
      status,
      files,
      missingFiles,
      extraFiles,
      changedFiles,
      update: status === "audited-match" ? { permitted: true, reason: `Matches the audited ${BASELINE.repo}@${BASELINE.ref.slice(0, 12)} content.` } : { permitted: false, reason: status === "modified" ? "The installed copy differs from its known source; it is preserved, not updated." : status === "incomplete" ? "The installed copy is missing audited files; nothing is filled in from a moving global directory." : "The method is not installed from a known source." }
    });
  }
  const core = [...methods_default.core];
  const blockingCore = methods.filter((method) => core.includes(method.name) && (method.status === "missing" || method.status === "incomplete")).map((method) => method.name);
  const modifiedCore = methods.filter((method) => core.includes(method.name) && method.status === "modified").map((method) => method.name);
  const guidance = blockingCore.length === 0 ? null : `${blockingCore.join(", ")} is missing or incomplete and must be installed from a known source before an issue, branch, worktree or workspace is created. Verified: ${BASELINE.repo}@${BASELINE.ref.slice(0, 12)}. Option A (selected skills only): ${methods_default.skillsCli}. Option B (whole official plugin, installs all ${methods_default.pluginSkillCount} methods): ${methods_default.pluginInstall}. This flow never installs a method or a package manager by itself.`;
  return { root, ref: BASELINE.ref, core, methods, blockingCore, modifiedCore, guidance };
}

// src/questions.ts
import { createHash as createHash2 } from "node:crypto";
function canonical(input) {
  return JSON.stringify({
    purpose: input.purpose,
    facts: input.facts,
    options: input.options,
    recommendation: input.recommendation ?? null,
    missingInformation: input.missingInformation ?? [],
    permissions: input.permissions
  });
}
function buildPacket(input) {
  if (!input.purpose.trim()) throw new Error("A question packet needs its purpose.");
  if (input.options.length === 0) throw new Error("A question packet needs at least one option.");
  if (input.permissions.length === 0) throw new Error("A question packet must state the permission consequences.");
  const ids = new Set(input.options.map((option) => option.id));
  if (ids.size !== input.options.length) throw new Error("Option ids must be unique.");
  for (const option of input.options) {
    if (!option.permission.trim()) throw new Error(`Option ${option.id} must state what it permits.`);
  }
  return {
    id: createHash2("sha256").update(canonical(input)).digest("hex"),
    purpose: input.purpose,
    facts: [...input.facts],
    options: input.options.map((option) => ({ ...option })),
    recommendation: input.recommendation ?? null,
    missingInformation: [...input.missingInformation ?? []],
    permissions: [...input.permissions]
  };
}
function renderPacket(packet) {
  const lines2 = [`Purpose: ${packet.purpose}`, "Facts:"];
  for (const fact of packet.facts) lines2.push(`- ${fact}`);
  if (packet.missingInformation.length > 0) {
    lines2.push("Missing information:");
    for (const missing2 of packet.missingInformation) lines2.push(`- ${missing2}`);
  }
  lines2.push("Options:");
  for (const option of packet.options) {
    lines2.push(`- ${option.id}: ${option.label} | tradeoff: ${option.tradeoff} | permits: ${option.permission}`);
  }
  if (packet.recommendation !== null) lines2.push(`Recommendation: ${packet.recommendation}`);
  lines2.push("Permission consequences:");
  for (const permission of packet.permissions) lines2.push(`- ${permission}`);
  return lines2.join("\n");
}
function coldReadPrompt(packet) {
  return [
    "You are a cold reader. You have no tools and no conversation history.",
    "Answer only from the packet below.",
    "First line: ANSWERABLE or NOT_ANSWERABLE, then the option id you would choose, or BLOCKED and the exact missing fact.",
    "Then explain in at most three sentences why, citing packet lines.",
    "",
    renderPacket(packet)
  ].join("\n");
}
function approvalPacket(input) {
  return buildPacket({
    purpose: `Approve the design for ${input.runId} candidate revision ${input.candidateRevision}?`,
    facts: [`Scope: ${input.scope}`, `Base: ${input.base}`, `Proposal: ${input.content}`],
    options: [
      {
        id: "approve",
        label: "Approve this candidate",
        tradeoff: "Implementation writes open for this scope only.",
        permission: "Permits implementation writes inside the stated scope at the current revision and input revision."
      },
      {
        id: "cancel",
        label: "Keep implementation closed",
        tradeoff: "Nothing is written; the candidate stays reviewable.",
        permission: "Permits nothing; the run stays in alignment."
      }
    ],
    recommendation: null,
    missingInformation: [],
    permissions: [
      "Approval binds this run, owner epoch, candidate digest and input revision.",
      "A later candidate or input change makes this grant stale; it is never silently extended.",
      "Approval does not permit merge, publication or delivery."
    ]
  });
}

// src/helpers.ts
var HELPER_TOOLS = { "cold-read": [], review: ["read", "grep", "glob"] };
async function runHelper(sdk, job) {
  if (!job.binding.taskId || !Number.isSafeInteger(job.binding.epoch) || job.binding.epoch < 0 || !/^[a-f0-9]{64}$/.test(job.binding.snapshotDigest)) {
    throw new Error("A helper job needs its task, epoch and method snapshot identity.");
  }
  const tools = [...HELPER_TOOLS[job.kind]];
  const options = {
    cwd: job.cwd,
    sessionManager: sdk.SessionManager.inMemory(job.cwd),
    restrictToolNames: true,
    toolNames: tools,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    noContextFiles: true,
    contextFiles: [],
    excludeAgentsMd: true,
    skills: [],
    promptTemplates: [],
    slashCommands: [],
    disableExtensionDiscovery: true,
    additionalExtensionPaths: [],
    bindProcessState: false,
    cacheWarming: "off",
    autoTitle: false,
    deferHintCompression: true,
    disableModelFallback: true,
    disableServerSideFallback: true
  };
  if (job.model) options.model = job.model;
  if (job.modelRegistry) {
    options.modelRegistry = job.modelRegistry;
    options.authStorage = job.modelRegistry.authStorage;
  }
  const created = await sdk.createAgentSession(options);
  const session = created.session;
  let text;
  try {
    const accepted = await session.prompt(job.prompt);
    if (!accepted) throw new Error("The helper session refused the job prompt.");
    await session.waitForIdle();
    text = session.getLastAssistantText();
  } finally {
    await session.dispose();
  }
  if (text === void 0) throw new Error("The helper session ended without an assistant answer.");
  const actual = job.model ?? session.model;
  if (!actual) throw new Error("The helper session ran without a resolvable model identity.");
  return { kind: job.kind, text, tools, binding: job.binding, model: { provider: actual.provider, id: actual.id } };
}

// src/binding.ts
import { createHash as createHash3 } from "node:crypto";
function captureTools(names) {
  const sorted = [...names].sort();
  return { names: sorted, digest: digestOf(sorted) };
}
function digestOf(names) {
  const hash = createHash3("sha256");
  for (const name of names) hash.update(name).update("\0");
  return hash.digest("hex");
}
function validateBinding(captured, current, expectation) {
  const minted = `mcp__${expectation.server.replace(/[^a-zA-Z0-9_]/g, "_")}_${expectation.tool}`;
  const blockers = [];
  if (!captured.names.includes(minted)) blockers.push(`the captured tool set never contained ${minted}`);
  if (!current.includes(minted)) blockers.push(`${minted} is not active now; refusing to substitute another connection`);
  if (digestOf(captured.names) !== captured.digest) blockers.push("the captured tool set was altered after capture");
  return { ok: blockers.length === 0, blockers };
}

// src/evidence.ts
function staleReasons(proof, current) {
  const reasons = [];
  if (proof.worktree !== current.worktree) reasons.push("worktree");
  if (proof.base !== current.base) reasons.push("review base");
  if (proof.head !== current.head) reasons.push("head");
  if (proof.candidateDigest !== current.candidateDigest) reasons.push("candidate");
  if (proof.configDigest !== current.configDigest) reasons.push("configuration");
  if (proof.inputRevision !== current.inputRevision) reasons.push("input revision");
  return reasons;
}
function deliveryBlockers(proofs, current) {
  return proofs.flatMap((proof) => {
    const reasons = staleReasons(proof, current);
    return reasons.length === 0 ? [] : [`${proof.kind} ${proof.name} is stale (${reasons.join(", ")})`];
  });
}

// src/delivery.ts
function prBody(request, marker) {
  const checks = request.proofs.map((proof) => `- ${proof.kind} ${proof.name}: ${proof.detail.slice(0, 200)}`).join("\n");
  const scope = request.proofs.length > 0 ? "The change was reviewed against the approved scope and the project's vocabulary; the review proof is bound to this exact base and head." : "";
  return [
    `${marker}`,
    `
## Summary
${request.title} \u2014 the single delivery for run ${request.runId} against ${request.prBase}.`,
    `
## Evidence
Base ${request.integrationBase.slice(0, 12)} \u2192 head ${request.head.slice(0, 12)}.
${checks || "No recorded proofs."}
${scope}`,
    `
## Merge Danger
**Door:** one-way if the base moved under this branch (force-with-lease was used); review the rebase before merging.
**Blast Radius:** this branch only; the run never merges or publishes itself.`
  ].join("");
}
function deliveryMarker(runId) {
  return `feat-flow-delivery:${runId}`;
}
function hasDeliveryMarker(description, marker) {
  const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._-])`);
  return pattern.test(description);
}
async function deliver(request, ports) {
  const marker = deliveryMarker(request.runId);
  const binding = validateBinding(request.binding.captured, request.binding.current, request.binding.expect);
  const blockers = [...binding.blockers, ...deliveryBlockers(request.proofs, request.current)];
  if (blockers.length > 0) return { outcome: "blocked", blockers, pr: null, linear: null, detail: "the captured binding or the evidence no longer matches this delivery" };
  const remoteHead = await ports.git(["ls-remote", "--heads", request.remote, request.branch], request.worktree).catch(() => null);
  if (remoteHead === null || remoteHead.code !== 0) {
    return { outcome: "unknown", blockers: [], pr: null, linear: null, detail: "the remote head could not be read; nothing is assumed about the push" };
  }
  const remoteSha = /^([0-9a-f]{40})\s/m.exec(remoteHead.stdout)?.[1] ?? null;
  if (remoteSha !== request.head) {
    const pushed = await ports.git([
      "push",
      `--force-with-lease=refs/heads/${request.branch}:${remoteSha ?? ""}`,
      request.remote,
      `${request.head}:refs/heads/${request.branch}`
    ], request.worktree).catch((error) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
    if (pushed.code !== 0) {
      const after = await ports.git(["ls-remote", "--heads", request.remote, request.branch], request.worktree).catch(() => null);
      const now = after && after.code === 0 ? /^([0-9a-f]{40})\s/m.exec(after.stdout)?.[1] ?? null : null;
      if (after === null || after.code !== 0 || now !== request.head) {
        return {
          outcome: "unknown",
          blockers: [],
          pr: null,
          linear: null,
          detail: `push did not apply (remote head ${now?.slice(0, 12) ?? "unreadable"}): ${pushed.stderr.trim().slice(0, 300)}`
        };
      }
    }
  }
  const usable = (candidate) => (candidate.base === void 0 || candidate.base === request.prBase) && (candidate.state === void 0 || candidate.state === "OPEN");
  const existing = (await ports.github.findPullRequests(request.branch)).filter((pr2) => pr2.headRefOid === request.head && usable(pr2));
  let pr;
  if (existing.length > 1) {
    return { outcome: "unknown", blockers: [], pr: null, linear: null, detail: "more than one pull request matches this head; refusing to guess" };
  }
  if (existing.length === 1) pr = existing[0];
  else {
    try {
      pr = await ports.github.createPullRequest({
        head: request.branch,
        base: request.prBase,
        title: request.title,
        // The upstream `pr` skill's body shape: the smallest statement of the change, real evidence,
        // and an explicit door call, instead of a bare marker line.
        body: prBody(request, marker)
      });
    } catch (error) {
      const reconciled = (await ports.github.findPullRequests(request.branch)).filter((candidate) => candidate.headRefOid === request.head && usable(candidate));
      if (reconciled.length !== 1) {
        return {
          outcome: "unknown",
          blockers: [],
          pr: null,
          linear: null,
          detail: `create response lost and reconciliation found ${reconciled.length} candidates: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      pr = reconciled[0];
    }
  }
  const issue = await ports.linear.getIssue(request.issue, marker);
  if (!issue) return { outcome: "unknown", blockers, pr, linear: null, detail: `issue ${request.issue} was not readable through the captured binding` };
  if (issue.hasMarker) {
    return {
      outcome: "delivered",
      blockers: [],
      pr,
      linear: { identifier: issue.identifier, state: issue.state, updated: false },
      detail: `PR #${pr.number} and ${issue.identifier} were already reconciled`
    };
  }
  try {
    await ports.linear.updateIssue(request.issue, { state: request.reviewState, marker });
  } catch (error) {
    const after = await ports.linear.getIssue(request.issue, marker);
    if (after?.hasMarker) {
      return {
        outcome: "delivered",
        blockers: [],
        pr,
        linear: { identifier: after.identifier, state: after.state, updated: true },
        detail: `backwrite confirmed by reading ${after.identifier} back`
      };
    }
    return {
      outcome: "unknown",
      blockers,
      pr,
      linear: { identifier: request.issue, state: after?.state ?? "unknown", updated: false },
      detail: `Linear backwrite unconfirmed: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  return {
    outcome: "delivered",
    blockers: [],
    pr,
    linear: { identifier: request.issue, state: "In Review", updated: true },
    detail: `PR #${pr.number} opened against ${request.prBase}; ${request.issue} moved to In Review`
  };
}

// src/github.ts
function gh(args) {
  const result = Bun.spawnSync(["gh", ...args]);
  if (result.exitCode !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr.toString().slice(-400)}`);
  return result.stdout.toString();
}
function githubClient(repository) {
  return {
    async findPullRequests(headBranch) {
      const out = gh(["pr", "list", "--repo", repository, "--head", headBranch, "--state", "all", "--json", "number,url,headRefOid,body,baseRefName,state"]);
      return JSON.parse(out).map((pr) => ({ number: pr.number, url: pr.url, headRefOid: pr.headRefOid, body: pr.body, base: pr.baseRefName, state: pr.state }));
    },
    async createPullRequest(input) {
      const url = gh(["pr", "create", "--repo", repository, "--head", input.head, "--base", input.base, "--title", input.title, "--body", input.body]).trim();
      const number = Number(/(\d+)\s*$/.exec(url)?.[1] ?? 0);
      if (!number) throw new Error(`gh pr create returned no pull request number: ${url.slice(0, 200)}`);
      return { number, url, headRefOid: "", body: input.body, base: input.base, state: "OPEN" };
    }
  };
}

// src/linear.ts
async function resolveLinearKey() {
  if (process.env.LINEAR_API_KEY) return process.env.LINEAR_API_KEY;
  const child = Bun.spawn(["security", "find-generic-password", "-s", "omp-linear-api-key", "-w"], { stdout: "pipe", stderr: "pipe" });
  const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}
function linearClient(key) {
  const call = async (query, variables = {}) => {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json();
    if (!response.ok || payload.errors) throw new Error(`linear ${response.status}: ${JSON.stringify(payload.errors ?? payload).slice(0, 400)}`);
    return payload.data ?? {};
  };
  const read = async (identifier) => {
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
      const states = (await call(`query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`, { id: issue.id })).issue.team.states.nodes;
      const stateId = states.find((state) => state.name === change.state)?.id;
      if (!stateId) throw new Error(`the issue team has no state named ${change.state}`);
      await call(
        `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
        { id: issue.id, input: { stateId, description: `${issue.description}

${change.marker}` } }
      );
    }
  };
}

// src/run.ts
import { createHash as createHash4, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir as mkdir2, open, realpath as realpath2, rename, rm } from "node:fs/promises";
import { dirname as dirname2, join as join3, resolve as resolve3 } from "node:path";
import { isFileLockHeld, tryAcquireFileLock, withFileLock } from "@oh-my-pi/pi-utils/file-lock";

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// src/run.ts
var projectDefaultsSchema = external_exports.object({
  git: external_exports.object({ remote: external_exports.string().min(1), startRef: external_exports.string().min(1), prBase: external_exports.string().min(1), worktreeRoot: external_exports.string().min(1) }).strict(),
  github: external_exports.object({ host: external_exports.string().regex(/^[a-zA-Z0-9.-]+$/), repository: external_exports.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/) }).strict(),
  linear: external_exports.object({
    workspaceId: external_exports.string().min(1),
    teamId: external_exports.string().min(1),
    statusMapping: external_exports.object({ inProgress: external_exports.string().min(1), inReview: external_exports.string().min(1), done: external_exports.string().min(1) }).strict()
  }).strict(),
  models: external_exports.object({ author: external_exports.string().min(1), helper: external_exports.string().min(1), reviewer: external_exports.string().min(1) }).strict(),
  knowledge: external_exports.object({ entryPaths: external_exports.array(external_exports.string().min(1)).max(64) }).strict()
}).strict();
var projectSnapshotSchema = external_exports.object({
  schemaVersion: external_exports.literal(1),
  revision: external_exports.number().int().positive(),
  digest: external_exports.string().regex(/^[a-f0-9]{64}$/),
  defaults: projectDefaultsSchema
}).strict();
var OPERATION_TYPES = ["git-sync", "git-commit", "git-push", "github-pr", "linear-issue", "linear-state", "dependency-update"];
var runIdSchema = external_exports.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
var locatorSchema = external_exports.object({ schemaVersion: external_exports.literal(1), runId: runIdSchema, commonDir: external_exports.string() }).strict();
var bindingSchema = external_exports.object({ processInstanceId: external_exports.string().min(1), sessionId: external_exports.string().min(1), contextEpoch: external_exports.number().int().nonnegative() }).strict();
var requestIdSchema = external_exports.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
var boundaryCategorySchema = external_exports.enum(["goals", "non-goals", "business-boundary", "error-path", "acceptance"]);
var grillingSchema = external_exports.object({
  decided: external_exports.array(external_exports.object({ category: boundaryCategorySchema, answer: external_exports.string().min(1) }).strict()).max(8),
  open: external_exports.array(boundaryCategorySchema).max(8)
}).strict();
var proofSchema = external_exports.object({
  kind: external_exports.enum(["check", "review"]),
  name: external_exports.string().min(1).max(200),
  worktree: external_exports.string().min(1),
  base: external_exports.string().regex(/^[a-f0-9]{40}$/),
  head: external_exports.string().regex(/^[a-f0-9]{40}$/),
  candidateDigest: external_exports.string().regex(/^[a-f0-9]{64}$/),
  configDigest: external_exports.string(),
  inputRevision: external_exports.number().int().positive(),
  detail: external_exports.string().max(4e3)
}).strict();
var planSchema = external_exports.object({
  activities: external_exports.array(external_exports.object({ kind: external_exports.enum(["prototype", "research", "spec", "ticket", "wizard"]), seam: external_exports.string().min(1), reason: external_exports.string().min(1) }).strict()).max(8),
  slices: external_exports.array(external_exports.object({ id: external_exports.string().min(1), behavior: external_exports.string().min(1), test: external_exports.string().min(1), dependsOn: external_exports.array(external_exports.string()) }).strict()).min(1).max(64),
  invariant: external_exports.string()
}).strict();
var requestIntentSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("task"), task: external_exports.string().min(1) }).strict(),
  external_exports.object({ kind: external_exports.literal("propose"), content: external_exports.string().min(1), scope: external_exports.string().min(1) }).strict(),
  external_exports.object({
    kind: external_exports.literal("knowledge"),
    path: external_exports.string().min(1).max(512),
    reason: external_exports.string().min(1).max(4e3),
    proposed: external_exports.string().max(131072)
  }).strict(),
  external_exports.object({ kind: external_exports.literal("boundaries"), decided: grillingSchema.shape.decided, open: grillingSchema.shape.open }).strict(),
  external_exports.object({ kind: external_exports.literal("plan"), plan: planSchema }).strict()
]);
var outboxSchema = external_exports.object({
  runId: runIdSchema,
  requestId: requestIdSchema,
  role: external_exports.literal("executor"),
  actor: bindingSchema.extend({ epoch: external_exports.number().int().positive() }),
  ownerEpoch: external_exports.number().int().positive(),
  revision: external_exports.number().int().nonnegative(),
  inputRevision: external_exports.number().int().positive(),
  intentDigest: external_exports.string().regex(/^[a-f0-9]{64}$/),
  status: external_exports.literal("consumed")
}).strict();
var candidateSchema = external_exports.object({ digest: external_exports.string().regex(/^[a-f0-9]{64}$/), revision: external_exports.number().int().positive(), scope: external_exports.string(), contentPath: external_exports.string(), configDigest: external_exports.string(), inputRevision: external_exports.number().int().positive() }).strict();
var operationDefinitionSchema = external_exports.object({ id: external_exports.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/), type: external_exports.enum(OPERATION_TYPES), target: external_exports.string().min(1).max(2048), intentDigest: external_exports.string().regex(/^[a-f0-9]{64}$/) }).strict();
var operationReceiptSchema = external_exports.object({ target: external_exports.string(), intentDigest: external_exports.string(), reference: external_exports.string().min(1).max(4096) }).strict();
var operationSchema = operationDefinitionSchema.extend({
  status: external_exports.enum(["prepared", "dispatched", "unknown", "settled"]),
  ownerEpoch: external_exports.number().int().positive(),
  configDigest: external_exports.string(),
  inputRevision: external_exports.number().int().positive(),
  approvalDigest: external_exports.string().nullable(),
  failureReason: external_exports.string().nullable(),
  outcome: external_exports.enum(["applied", "not-applied"]).nullable(),
  receipt: operationReceiptSchema.nullable()
}).strict();
var stateSchema = external_exports.object({
  schemaVersion: external_exports.literal(1),
  runId: runIdSchema,
  repoIdentity: external_exports.string(),
  commonDir: external_exports.string(),
  worktree: external_exports.string(),
  branch: external_exports.string(),
  git: external_exports.object({ remote: external_exports.string(), prBase: external_exports.string(), privateStartRef: external_exports.string(), worktreeGitDir: external_exports.string() }).strict(),
  startSha: external_exports.string(),
  currentIntegrationSha: external_exports.string(),
  loadedBuildId: external_exports.string(),
  ownerEpoch: external_exports.number().int().nonnegative(),
  owner: bindingSchema.extend({ epoch: external_exports.number().int().positive() }).nullable(),
  revision: external_exports.number().int().nonnegative(),
  phase: external_exports.enum(["alignment", "implementation", "delivery"]),
  issue: external_exports.string().regex(/^[A-Z][A-Z0-9]+-\d+$/).nullable(),
  workspace: external_exports.object({ workspaceId: external_exports.string().nullable(), verified: external_exports.boolean(), continuation: external_exports.string(), handoff: external_exports.string() }).strict().nullable(),
  currentTask: external_exports.string().nullable(),
  knowledgeCandidate: external_exports.object({
    path: external_exports.string().min(1).max(512),
    reason: external_exports.string().min(1).max(4e3),
    proposed: external_exports.string().max(131072)
  }).strict().nullable(),
  candidateRevision: external_exports.number().int().nonnegative(),
  candidate: candidateSchema.nullable(),
  approvedScope: candidateSchema.nullable(),
  project: projectSnapshotSchema.nullable(),
  operations: external_exports.array(operationSchema).max(128),
  lastIntentDigest: external_exports.string().regex(/^[a-f0-9]{64}$/).nullable(),
  consumedIntents: external_exports.array(external_exports.string().regex(/^[a-f0-9]{64}$/)).max(64),
  outbox: outboxSchema.nullable(),
  grilling: grillingSchema.nullable(),
  plan: planSchema.nullable(),
  proofs: external_exports.array(proofSchema).max(64),
  readiness: external_exports.enum(["ready", "blocked"]),
  waitingReason: external_exports.string().nullable(),
  configDigest: external_exports.string(),
  inputRevision: external_exports.number().int().positive()
}).strict();
var inputSchema = external_exports.discriminatedUnion("kind", [
  external_exports.object({ kind: external_exports.literal("task"), task: external_exports.string().min(1) }).strict(),
  external_exports.object({ kind: external_exports.literal("propose"), content: external_exports.string().min(1), scope: external_exports.string().min(1) }).strict(),
  external_exports.object({
    kind: external_exports.literal("knowledge"),
    path: external_exports.string().min(1).max(512),
    reason: external_exports.string().min(1).max(4e3),
    proposed: external_exports.string().max(131072)
  }).strict(),
  external_exports.object({ kind: external_exports.literal("request.submit"), requestId: requestIdSchema, expectedRevision: external_exports.number().int().nonnegative(), intent: requestIntentSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("approve"), source: external_exports.literal("native-ui"), approved: external_exports.literal(true), runId: external_exports.string().min(1), digest: external_exports.string(), candidateRevision: external_exports.number().int(), ownerEpoch: external_exports.number().int() }).strict(),
  external_exports.object({ kind: external_exports.literal("owner.authorize"), source: external_exports.literal("native-ui"), approved: external_exports.literal(true), runId: external_exports.string().min(1), digest: external_exports.string(), candidateRevision: external_exports.number().int(), ownerEpoch: external_exports.number().int() }).strict(),
  external_exports.object({ kind: external_exports.literal("rebind"), contextEpoch: external_exports.number().int().nonnegative() }).strict(),
  external_exports.object({ kind: external_exports.literal("operation.prepare"), operation: operationDefinitionSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("operation.resume"), operationId: external_exports.string(), intentDigest: external_exports.string() }).strict(),
  external_exports.object({ kind: external_exports.literal("operation.dispatch"), operationId: external_exports.string() }).strict(),
  external_exports.object({ kind: external_exports.literal("operation.unknown"), operationId: external_exports.string(), reason: external_exports.string().min(1).max(4096) }).strict(),
  external_exports.object({ kind: external_exports.literal("operation.settle"), operationId: external_exports.string(), outcome: external_exports.enum(["applied", "not-applied"]), receipt: operationReceiptSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("proof.record"), proof: proofSchema }).strict(),
  external_exports.object({ kind: external_exports.literal("beginDelivery") }).strict(),
  external_exports.object({ kind: external_exports.literal("bindIssue"), issue: external_exports.string().regex(/^[A-Z][A-Z0-9]+-\d+$/) }).strict(),
  external_exports.object({ kind: external_exports.literal("workspace.record"), workspace: external_exports.object({
    workspaceId: external_exports.string().nullable(),
    verified: external_exports.boolean(),
    continuation: external_exports.string(),
    handoff: external_exports.string()
  }).strict().nullable() }).strict(),
  external_exports.object({ kind: external_exports.literal("sync"), previousIntegrationSha: external_exports.string().regex(/^[a-f0-9]{40}$/), newIntegrationSha: external_exports.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  external_exports.object({ kind: external_exports.literal("restore") }).strict()
]);
var RunBusyError = class extends Error {
  constructor() {
    super("This run has an active owner; inspect it without taking over.");
    this.name = "RunBusyError";
  }
};
var RunOwnershipError = class extends Error {
  constructor() {
    super("This action does not belong to the active run owner and context.");
    this.name = "RunOwnershipError";
  }
};
function missing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
var RunStateSchemaError = class extends Error {
  constructor(path, found) {
    super(`run state at ${path} has unsupported schemaVersion ${JSON.stringify(found)}; this build reads schema 1 and refuses to guess`);
    this.path = path;
    this.found = found;
    this.name = "RunStateSchemaError";
  }
};
function readRunState(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  const version = raw !== null && typeof raw === "object" && "schemaVersion" in raw ? raw.schemaVersion : void 0;
  if (version !== 1) throw new RunStateSchemaError(path, version);
  return stateSchema.parse(raw);
}
function readLocator(path) {
  try {
    return locatorSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}
function proposalBody(configDigest, inputRevision, content, scope) {
  return JSON.stringify({ content, scope, configDigest, inputRevision }) + "\n";
}
function digest(content) {
  return createHash4("sha256").update(content).digest("hex");
}
async function sealMaterial(directory, body) {
  const hash = digest(body);
  await mkdir2(directory, { recursive: true, mode: 448 });
  const path = join3(directory, hash + ".json");
  await writeAtomic(path, body);
  return { digest: hash, path };
}
async function writeAtomic(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 384);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname2(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
function sameBinding(owner, binding) {
  return owner !== null && owner.processInstanceId === binding.processInstanceId && owner.sessionId === binding.sessionId && owner.contextEpoch === binding.contextEpoch;
}
function readProject(commonDir) {
  let snapshot;
  try {
    snapshot = projectSnapshotSchema.parse(JSON.parse(readFileSync(join3(commonDir, "omp-feat-flow", "project.json"), "utf8")));
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  if (snapshot.digest !== digest(JSON.stringify(snapshot.defaults))) throw new Error("Project defaults do not match their recorded digest.");
  return snapshot;
}
function locateRun(location) {
  const locator = readLocator(join3(location.worktreeGitDir, "omp-feat-flow.json"));
  if (!locator) return null;
  if (locator.commonDir !== location.commonDir) throw new Error("Worktree locator points to another repository.");
  const state = readRunState(join3(location.commonDir, "omp-feat-flow", "runs", locator.runId, "state.json"));
  if (!state || state.runId !== locator.runId || state.repoIdentity !== location.repoIdentity || state.commonDir !== location.commonDir || state.worktree !== location.repo || state.branch !== location.branch || state.git.worktreeGitDir !== location.worktreeGitDir) throw new Error("The locator does not identify this actual Git worktree; no authority was inherited.");
  return { runId: state.runId, repo: {
    runId: state.runId,
    repo: location.repo,
    repoIdentity: state.repoIdentity,
    commonDir: state.commonDir,
    worktree: state.worktree,
    worktreeGitDir: state.git.worktreeGitDir,
    branch: state.branch,
    remote: state.git.remote,
    prBase: state.git.prBase,
    privateStartRef: state.git.privateStartRef,
    startSha: state.startSha,
    currentIntegrationSha: state.currentIntegrationSha
  } };
}
var RunKernel = class _RunKernel {
  #context;
  #statePath;
  #ownerPath;
  #lease;
  #ownerEpoch = 0;
  #storageFailed = false;
  #authorizedScopeDigest = null;
  #binding;
  constructor(context, statePath, ownerPath, lease) {
    this.#context = context;
    this.#statePath = statePath;
    this.#ownerPath = ownerPath;
    this.#lease = lease;
    this.#binding = bindingSchema.parse(context.binding);
  }
  static async open(context) {
    runIdSchema.parse(context.runId);
    if (context.repo.runId !== context.runId) throw new Error("Prepared worktree belongs to a different run.");
    bindingSchema.parse(context.binding);
    const runDirectory = join3(context.repo.commonDir, "omp-feat-flow", "runs", context.runId);
    if (context.mode === "owner") await mkdir2(runDirectory, { recursive: true, mode: 448 });
    const statePath = join3(runDirectory, "state.json");
    const ownerPath = join3(runDirectory, "owner");
    const lease = context.mode === "owner" ? tryAcquireFileLock(ownerPath) : null;
    if (context.mode === "owner" && !lease) throw new RunBusyError();
    const kernel = new _RunKernel(context, statePath, ownerPath, lease);
    try {
      if (context.mode === "inspect") {
        if (!readRunState(statePath)) throw new Error("Run not found.");
      } else {
        const locatorPath = join3(context.repo.worktreeGitDir, "omp-feat-flow.json");
        const locator = readLocator(locatorPath);
        if (locator && (locator.runId !== context.runId || locator.commonDir !== context.repo.commonDir)) throw new Error("This worktree already locates a different run.");
        await withFileLock(statePath, async () => {
          const previous = readRunState(statePath);
          const state = previous ?? kernel.#initialState();
          if (previous) {
            state.readiness = "blocked";
            state.waitingReason = "owner-recovery";
            for (const operation of state.operations) if (operation.status === "dispatched") {
              operation.status = "unknown";
              operation.failureReason = "Previous owner ended before settlement.";
            }
          }
          if (state.runId !== context.runId || state.commonDir !== context.repo.commonDir || state.worktree !== context.repo.worktree || state.branch !== context.repo.branch || state.startSha !== context.repo.startSha || state.git.worktreeGitDir !== context.repo.worktreeGitDir || state.git.remote !== context.repo.remote || state.git.prBase !== context.repo.prBase || state.git.privateStartRef !== context.repo.privateStartRef) throw new Error("Run identity does not match this worktree.");
          state.ownerEpoch += 1;
          state.owner = { ...context.binding, epoch: state.ownerEpoch };
          state.loadedBuildId = context.buildId;
          state.revision += 1;
          if (!locator) await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: context.runId, commonDir: context.repo.commonDir }) + "\n");
          await writeAtomic(statePath, JSON.stringify(state) + "\n");
          kernel.#ownerEpoch = state.ownerEpoch;
        }, { retries: 50, retryDelayMs: 10 });
      }
      return kernel;
    } catch (error) {
      lease?.release();
      throw error;
    }
  }
  /** Create the run for this worktree. The creating session owns it; an existing run is never overwritten. */
  static async create(context) {
    runIdSchema.parse(context.runId);
    if (context.repo.runId !== context.runId) throw new Error("Prepared worktree belongs to a different run.");
    bindingSchema.parse(context.binding);
    const runDirectory = join3(context.repo.commonDir, "omp-feat-flow", "runs", context.runId);
    await mkdir2(runDirectory, { recursive: true, mode: 448 });
    const statePath = join3(runDirectory, "state.json");
    const ownerPath = join3(runDirectory, "owner");
    const lease = tryAcquireFileLock(ownerPath);
    if (!lease) throw new RunBusyError();
    const kernel = new _RunKernel(context, statePath, ownerPath, lease);
    try {
      const locatorPath = join3(context.repo.worktreeGitDir, "omp-feat-flow.json");
      await withFileLock(statePath, async () => {
        if (readRunState(statePath) || readLocator(locatorPath)) throw new Error("This worktree already has a run; open it instead of starting again.");
        const state = kernel.#initialState();
        state.ownerEpoch = 1;
        state.owner = { ...context.binding, epoch: 1 };
        state.revision = 1;
        await writeAtomic(statePath, JSON.stringify(state) + "\n");
        await writeAtomic(locatorPath, JSON.stringify({ schemaVersion: 1, runId: context.runId, commonDir: context.repo.commonDir }) + "\n");
        kernel.#ownerEpoch = 1;
      }, { retries: 50, retryDelayMs: 10 });
      return kernel;
    } catch (error) {
      lease.release();
      throw error;
    }
  }
  #initialState() {
    const { repo, runId, buildId } = this.#context;
    const project = this.#context.project === void 0 ? readProject(repo.commonDir) : projectSnapshotSchema.parse(this.#context.project);
    if (project && (project.digest !== digest(JSON.stringify(project.defaults)) || project.defaults.git.remote !== repo.remote || project.defaults.git.prBase !== repo.prBase)) throw new Error("Project snapshot does not match the prepared run.");
    return {
      schemaVersion: 1,
      runId,
      repoIdentity: repo.repoIdentity,
      commonDir: repo.commonDir,
      worktree: repo.worktree,
      branch: repo.branch,
      startSha: repo.startSha,
      workspace: null,
      git: { remote: repo.remote, prBase: repo.prBase, privateStartRef: repo.privateStartRef, worktreeGitDir: repo.worktreeGitDir },
      currentIntegrationSha: repo.currentIntegrationSha,
      loadedBuildId: buildId,
      lastIntentDigest: null,
      consumedIntents: [],
      knowledgeCandidate: null,
      outbox: null,
      grilling: null,
      plan: null,
      proofs: [],
      ownerEpoch: 0,
      owner: null,
      revision: 0,
      phase: "alignment",
      issue: null,
      currentTask: null,
      candidateRevision: 0,
      candidate: null,
      approvedScope: null,
      project,
      operations: [],
      readiness: "ready",
      waitingReason: null,
      configDigest: digest(JSON.stringify({ repoIdentity: repo.repoIdentity, projectDigest: project?.digest ?? null, remote: repo.remote, prBase: repo.prBase })),
      inputRevision: 1
    };
  }
  #read() {
    const state = readRunState(this.#statePath);
    if (!state) throw new Error("Run state is missing; writes are blocked.");
    return state;
  }
  #owned(state, binding) {
    if (!this.#lease || this.#storageFailed || state.ownerEpoch !== this.#ownerEpoch || !sameBinding(state.owner, binding)) throw new RunOwnershipError();
  }
  async #propose(state, content, scope) {
    const body = proposalBody(state.configDigest, state.inputRevision, content, scope);
    let material;
    try {
      material = await sealMaterial(join3(dirname2(this.#statePath), "materials"), body);
    } catch (error) {
      this.#storageFailed = true;
      throw error;
    }
    state.candidateRevision += 1;
    state.candidate = {
      digest: material.digest,
      contentPath: material.path,
      revision: state.candidateRevision,
      scope,
      configDigest: state.configDigest,
      inputRevision: state.inputRevision
    };
    state.approvedScope = null;
    state.phase = "alignment";
  }
  #verifyMaterial(candidate) {
    if (candidate.contentPath !== join3(dirname2(this.#statePath), "materials", candidate.digest + ".json") || digest(readFileSync(candidate.contentPath, "utf8")) !== candidate.digest) throw new Error("A bound candidate material is missing or changed.");
  }
  inspect() {
    const state = this.#read();
    const ownerStatus = this.#lease && state.ownerEpoch === this.#ownerEpoch && sameBinding(state.owner, this.#binding) ? "self" : isFileLockHeld(this.#ownerPath) ? "other" : "unclaimed";
    let reason = this.#storageFailed ? "durable-state-write-failed" : state.waitingReason;
    if (!this.#storageFailed && state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest && !state.operations.some((operation) => operation.status === "dispatched" || operation.status === "unknown")) reason = "owner-authorization-required";
    try {
      if (state.candidate) this.#verifyMaterial(state.candidate);
      if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
    } catch {
      reason = "bound-material-unavailable";
    }
    return { ...state, ownerStatus, readiness: reason ? "blocked" : state.readiness, waitingReason: reason };
  }
  /**
   * The delivery gate is the full recorded identity: a review proof for this worktree, the current
   * integration base, the observed HEAD, the approved candidate and the current configuration.
   */
  #deliveryEvidence(state) {
    const scope = state.approvedScope;
    if (!scope) return false;
    return state.proofs.some((proof) => proof.kind === "review" && proof.worktree === state.worktree && proof.base === state.currentIntegrationSha && proof.candidateDigest === scope.digest && proof.configDigest === state.configDigest && proof.inputRevision === state.inputRevision);
  }
  admit(attempt, binding) {
    let state;
    let reason = "run-state-unavailable";
    try {
      state = this.#read();
      this.#owned(state, binding);
      if (state.readiness !== "ready") reason = state.waitingReason ?? "recovery-not-ready";
      else if (attempt.effect === "read") reason = "allowed";
      else if (attempt.effect === "write" && state.phase === "implementation" && state.approvedScope) {
        this.#verifyMaterial(state.approvedScope);
        reason = this.#authorizedScopeDigest !== state.approvedScope.digest ? "owner-authorization-required" : state.approvedScope.configDigest === state.configDigest && state.approvedScope.inputRevision === state.inputRevision ? "allowed" : "approval-object-changed";
      } else reason = "scope-not-approved";
    } catch (error) {
      reason = this.#storageFailed ? "durable-state-write-failed" : error instanceof RunOwnershipError ? "owner-or-context-mismatch" : "bound-material-or-state-unavailable";
    }
    return { allow: reason === "allowed", reason, runId: this.#context.runId, revision: state?.revision ?? null, ownerEpoch: state?.ownerEpoch ?? null };
  }
  async apply(input, binding) {
    const request = inputSchema.parse(input);
    let certificate;
    let durableMutation = false;
    await withFileLock(this.#statePath, async () => {
      const state = this.#read();
      this.#owned(state, binding);
      let rebound;
      switch (request.kind) {
        case "task":
          state.currentTask = request.task;
          break;
        case "propose":
          await this.#propose(state, request.content, request.scope);
          break;
        case "request.submit": {
          if (state.readiness !== "ready") throw new Error("Recovery is blocked; a model request cannot bypass it.");
          if (request.expectedRevision !== state.revision) throw new Error("This model request observed a stale revision; inspect the run and submit it again.");
          const intent = request.intent;
          const intentDigest = digest(JSON.stringify(intent));
          const repeat = intent.kind === "task" ? state.currentTask === intent.task : intent.kind === "propose" ? state.candidate?.digest === digest(proposalBody(state.configDigest, state.inputRevision, intent.content, intent.scope)) : state.consumedIntents.includes(intentDigest);
          if (state.outbox?.requestId === request.requestId || repeat) throw new Error("An identical model request was already consumed; no further advance is permitted.");
          if (intent.kind === "task") state.currentTask = intent.task;
          else if (intent.kind === "knowledge") {
            state.knowledgeCandidate = { path: intent.path, reason: intent.reason, proposed: intent.proposed };
          } else if (intent.kind === "boundaries") {
            if (state.phase !== "alignment" || state.approvedScope) throw new Error("Boundaries can only change while the design is unapproved.");
            state.grilling = { decided: intent.decided, open: intent.open };
            state.plan = null;
          } else if (intent.kind === "plan") {
            if (!state.grilling || state.grilling.open.length > 0) throw new Error("A plan needs every boundary resolved first.");
            if (intent.plan.slices.length === 0) throw new Error("A plan needs at least one slice.");
            state.plan = intent.plan;
          } else await this.#propose(state, intent.content, intent.scope);
          state.outbox = {
            runId: state.runId,
            requestId: request.requestId,
            role: "executor",
            actor: { ...binding, epoch: state.ownerEpoch },
            ownerEpoch: state.ownerEpoch,
            revision: request.expectedRevision,
            inputRevision: state.inputRevision,
            intentDigest,
            status: "consumed"
          };
          state.lastIntentDigest = intentDigest;
          state.consumedIntents = [...state.consumedIntents, intentDigest].slice(-64);
          break;
        }
        case "approve": {
          if (state.readiness !== "ready" || request.runId !== state.runId || request.ownerEpoch !== state.ownerEpoch) throw new Error("This native approval is stale or recovery is blocked.");
          const knowledge = state.knowledgeCandidate;
          if (knowledge && !state.candidate) {
            if (request.digest !== digest(JSON.stringify(knowledge))) throw new Error("This knowledge approval is stale: the diff changed while you were deciding.");
            const root = resolve3(state.worktree);
            const target = resolve3(join3(root, knowledge.path));
            if (!target.startsWith(root + "/")) throw new Error(`${knowledge.path} escapes the project root.`);
            mkdir2(dirname2(target), { recursive: true, mode: 448 });
            await writeAtomic(target, knowledge.proposed);
            state.knowledgeCandidate = null;
            break;
          }
          if (!state.candidate || request.digest !== state.candidate.digest || request.candidateRevision !== state.candidate.revision) throw new Error("This native approval is stale or recovery is blocked.");
          this.#verifyMaterial(state.candidate);
          state.approvedScope = state.candidate;
          state.phase = "implementation";
          break;
        }
        case "owner.authorize": {
          const scope = state.approvedScope;
          if (state.readiness !== "blocked" || state.waitingReason !== "owner-recovery" && state.waitingReason !== "context-rebind" || state.phase === "alignment" || !scope || !state.candidate || request.runId !== state.runId || request.ownerEpoch !== state.ownerEpoch || request.digest !== scope.digest || request.candidateRevision !== scope.revision || state.candidate.digest !== scope.digest || state.candidate.revision !== scope.revision || scope.configDigest !== state.configDigest || scope.inputRevision !== state.inputRevision || state.operations.some((operation) => operation.status === "dispatched" || operation.status === "unknown")) throw new Error("Current native owner authorization is stale or recovery still has unresolved facts.");
          this.#verifyMaterial(scope);
          state.readiness = "ready";
          state.waitingReason = null;
          break;
        }
        case "workspace.record": {
          state.workspace = request.workspace;
          break;
        }
        case "bindIssue": {
          if (state.issue && state.issue !== request.issue) throw new Error(`This run already delivers ${state.issue}.`);
          state.issue = request.issue;
          break;
        }
        case "beginDelivery": {
          if (state.phase !== "implementation" || !state.approvedScope) throw new Error("Delivery starts only from an approved implementation.");
          if (!this.#deliveryEvidence(state))
            throw new Error("Delivery needs a review proof recorded for the current worktree and integration base.");
          state.phase = "delivery";
          break;
        }
        case "rebind": {
          if (request.contextEpoch <= binding.contextEpoch) throw new Error("Context generation must advance.");
          rebound = { ...binding, contextEpoch: request.contextEpoch };
          state.ownerEpoch += 1;
          state.owner = { ...rebound, epoch: state.ownerEpoch };
          state.readiness = "blocked";
          state.waitingReason = "context-rebind";
          break;
        }
        case "operation.prepare": {
          if (state.operations.length >= 128) throw new Error("Run operation budget exhausted; no history was discarded.");
          if (state.operations.some((operation) => operation.id === request.operation.id || operation.type === request.operation.type && operation.target === request.operation.target && (operation.status !== "settled" || operation.outcome === "applied" && operation.intentDigest === request.operation.intentDigest))) throw new Error("This operation already exists or requires reconciliation.");
          state.operations.push({
            ...request.operation,
            status: "prepared",
            ownerEpoch: state.ownerEpoch,
            configDigest: state.configDigest,
            inputRevision: state.inputRevision,
            approvalDigest: state.approvedScope?.digest ?? null,
            failureReason: null,
            outcome: null,
            receipt: null
          });
          break;
        }
        case "operation.resume": {
          const operation = state.operations.find((item) => item.id === request.operationId);
          if (!operation || operation.status !== "prepared" || operation.intentDigest !== request.intentDigest || operation.configDigest !== state.configDigest || operation.inputRevision !== state.inputRevision || operation.approvalDigest !== (state.approvedScope?.digest ?? null)) throw new Error("Only an unchanged, definitely unstarted operation may resume.");
          operation.ownerEpoch = state.ownerEpoch;
          break;
        }
        case "operation.dispatch": {
          if (state.readiness !== "ready") throw new Error("Restore readiness before dispatching an operation.");
          const operation = state.operations.find((item) => item.id === request.operationId);
          if (!operation || operation.status !== "prepared" || operation.ownerEpoch !== state.ownerEpoch || operation.configDigest !== state.configDigest || operation.inputRevision !== state.inputRevision || operation.approvalDigest !== (state.approvedScope?.digest ?? null) || state.operations.some((item) => item.status === "dispatched" || item.status === "unknown")) throw new Error("Operation cannot dispatch: identity changed, already dispatched, or reconciliation is pending.");
          operation.status = "dispatched";
          state.readiness = "blocked";
          state.waitingReason = "operation-in-flight";
          break;
        }
        case "operation.unknown": {
          const operation = state.operations.find((item) => item.id === request.operationId);
          if (!operation || operation.status !== "dispatched") throw new Error("Only an unsettled dispatched operation can become unknown.");
          operation.status = "unknown";
          operation.failureReason = request.reason;
          state.readiness = "blocked";
          state.waitingReason = "operation-result-unknown";
          break;
        }
        case "operation.settle": {
          const operation = state.operations.find((item) => item.id === request.operationId);
          if (!operation || operation.status !== "dispatched" && operation.status !== "unknown" || operation.target !== request.receipt.target || operation.intentDigest !== request.receipt.intentDigest) throw new Error("Settlement does not identify the outstanding owned operation.");
          operation.status = "settled";
          operation.outcome = request.outcome;
          operation.receipt = request.receipt;
          operation.failureReason = null;
          if (!state.operations.some((item) => item.status === "dispatched" || item.status === "unknown")) {
            state.readiness = "ready";
            state.waitingReason = null;
          }
          break;
        }
        case "proof.record": {
          if (state.readiness !== "ready") throw new Error("Recovery is blocked; a proof cannot be recorded.");
          state.proofs = [
            ...state.proofs.filter((proof) => !(proof.kind === request.proof.kind && proof.name === request.proof.name)),
            request.proof
          ].slice(-64);
          break;
        }
        case "sync": {
          if (request.previousIntegrationSha !== state.currentIntegrationSha) throw new Error("The reviewed base changed; inspect the run before recording a sync.");
          state.currentIntegrationSha = request.newIntegrationSha;
          break;
        }
        case "restore": {
          if (state.operations.some((operation) => operation.status === "dispatched" || operation.status === "unknown")) throw new Error("Reconcile outstanding effects before restoring writes.");
          if (state.candidate) this.#verifyMaterial(state.candidate);
          if (state.approvedScope && state.approvedScope.digest !== state.candidate?.digest) this.#verifyMaterial(state.approvedScope);
          if (state.approvedScope && this.#authorizedScopeDigest !== state.approvedScope.digest) throw new Error("Current owner authorization is required; the saved business scope is unchanged.");
          state.readiness = "ready";
          state.waitingReason = null;
          break;
        }
      }
      state.revision += 1;
      try {
        await writeAtomic(this.#statePath, JSON.stringify(state) + "\n");
      } catch (error) {
        this.#storageFailed = true;
        throw error;
      }
      durableMutation = true;
      if (request.kind === "approve" || request.kind === "owner.authorize") certificate = state.approvedScope?.digest ?? null;
      else if (request.kind === "propose") certificate = null;
      if (rebound) {
        this.#binding = rebound;
        this.#ownerEpoch = state.ownerEpoch;
      }
    }, { retries: 50, retryDelayMs: 10 }).catch((error) => {
      if (durableMutation) this.#storageFailed = true;
      throw error;
    });
    if (certificate !== void 0) this.#authorizedScopeDigest = certificate;
    return { view: this.inspect() };
  }
  async dispose() {
    this.#lease?.release();
    this.#lease = null;
  }
};
function openRun(context) {
  return RunKernel.open(context);
}

// src/update.ts
function inspectUpdate(request) {
  const installedBuildId = request.installed?.buildId ?? "";
  const version = request.installed?.version ?? "unknown";
  if (request.unresolvedEffects > 0) {
    return {
      loadedBuildId: request.loadedBuildId,
      installedBuildId,
      version,
      relation: "unknown",
      requiresRestart: false,
      blockers: [`${request.unresolvedEffects} effect(s) are unsettled; an upgrade cannot start from here`],
      detail: "blocked until every dispatched or unknown effect is reconciled"
    };
  }
  if (!request.installed) {
    return {
      loadedBuildId: request.loadedBuildId,
      installedBuildId,
      version,
      relation: "unknown",
      requiresRestart: false,
      blockers: ["no readable native installation metadata"],
      detail: "the installed artifact cannot be identified"
    };
  }
  if (request.installed.buildId === request.loadedBuildId) {
    return {
      loadedBuildId: request.loadedBuildId,
      installedBuildId,
      version,
      relation: "same",
      requiresRestart: false,
      blockers: [],
      detail: `running build ${request.loadedBuildId.slice(0, 12)} v${version}`
    };
  }
  return {
    loadedBuildId: request.loadedBuildId,
    installedBuildId,
    version,
    relation: "stale",
    requiresRestart: true,
    blockers: [],
    detail: `running ${request.loadedBuildId.slice(0, 12)} while ${installedBuildId.slice(0, 12)} v${version} is installed; only a real native restart loads it, and reload-plugins does not replace loaded code`
  };
}

// src/workspace.ts
import { basename } from "node:path";
function ownershipMarker(runId) {
  return `feat-flow:${runId}`;
}
function continuationCommand(worktree, _runId) {
  return `cd ${JSON.stringify(worktree)} && omp`;
}
var defaultRun = async (command, args) => {
  const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  return { code, stdout, stderr };
};
async function cmuxAvailable(run) {
  try {
    return (await run("cmux", ["workspace", "list"])).code === 0;
  } catch {
    return false;
  }
}
function jsonString(text, key) {
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && key in parsed) {
      const value = parsed[key];
      if (typeof value === "string") return value;
    }
  } catch {
  }
  return null;
}
function nonCmux(request, marker, continuation) {
  return { mode: "non-cmux", continuation, workspaceId: null, surfaceId: null, ownershipMarker: marker, handoff: "not-switched", verified: false };
}
async function ensureWorkspace(request, run = defaultRun) {
  const marker = ownershipMarker(request.runId);
  const continuation = continuationCommand(request.worktree, request.runId);
  if (!await cmuxAvailable(run)) return nonCmux(request, marker, continuation);
  const name = `${marker} ${basename(request.worktree)}`;
  const created = await run("cmux", [
    "--id-format",
    "uuids",
    "workspace",
    "create",
    "--name",
    name,
    "--description",
    marker,
    "--cwd",
    request.worktree,
    "--command",
    request.startCommand,
    "--focus",
    "true",
    "--json"
  ]);
  if (created.code !== 0) return nonCmux(request, marker, continuation);
  const createdId = jsonString(created.stdout, "workspace_id") ?? jsonString(created.stdout, "id");
  const surfaceId = jsonString(created.stdout, "surface_id");
  if (!createdId) return nonCmux(request, marker, continuation);
  let verified = false;
  for (let attempt = 0; attempt < 20 && !verified; attempt += 1) {
    if (attempt > 0) await new Promise((resolve5) => setTimeout(resolve5, 150));
    const listing = await run("cmux", ["workspace", "list", "--json"]);
    verified = listing.code === 0 && listing.stdout.includes(createdId) && listing.stdout.includes(marker);
  }
  return {
    mode: "cmux",
    continuation,
    workspaceId: createdId,
    surfaceId,
    ownershipMarker: marker,
    handoff: verified ? "switched" : "not-switched",
    verified
  };
}

// src/flow.ts
var dependenciesCore = methods_default.core;
var READ_ONLY_TOOLS = {
  read: true,
  grep: true,
  glob: true,
  ls: true,
  lsp: true,
  web_search: true,
  web_fetch: true,
  todo: true,
  ask: true
};
var REQUEST_TOOLS = { feat_flow_request: true };
var SPAWNING_TOOLS = { task: true };
function recoveryReceipt(projection) {
  if (!projection.located) return `no run: ${projection.reason}`;
  const facts = [
    `run ${projection.runId} r${projection.revision}`,
    `phase ${projection.phase}`,
    `${projection.readiness}${projection.waitingReason ? ` (${projection.waitingReason})` : ""}`,
    `owner ${projection.ownerStatus}`,
    `approved ${projection.approvedScopeDigest ? "yes" : "no"}`,
    `task ${projection.currentTask ?? "none"}`
  ];
  if (projection.unresolvedOperations > 0) facts.push(`${projection.unresolvedOperations} dispatched effect(s) unsettled`);
  if (projection.unknownOperations > 0) facts.push(`${projection.unknownOperations} effect(s) of unknown outcome`);
  if (projection.openBoundaries.length > 0) facts.push(`open boundaries: ${projection.openBoundaries.join(", ")}`);
  if (projection.planSlices > 0) facts.push(`${projection.planSlices} planned slice(s)`);
  return facts.join("; ");
}
function effectOf(toolName) {
  if (SPAWNING_TOOLS[toolName]) return "spawn";
  return READ_ONLY_TOOLS[toolName] || REQUEST_TOOLS[toolName] ? "read" : "write";
}
var operations = {
  status: "Report the current run: phase, readiness, wait reason, owner and approved scope.",
  start: "Create an isolated worktree and run for a requirement; binds the Linear issue when an identifier is given, otherwise the issue is bound later. Never creates duplicate branches or workspaces.",
  update: "Report which installed methods may be updated; never overwrite a modified or unknown copy.",
  sync: "Fetch the configured PR base into the run's private ref, rebase the owned work and record the new review base.",
  finish: "Independent review, sync to the PR base, push, open one PR, update the Linear issue, then close this run's owned workspace. Never merges or publishes.",
  approve: "Show the current candidate and its exact consequences in the native UI; only an explicit confirmation approves it."
};
function flowCommandDescription(name) {
  return operations[name];
}
function createFlow(host) {
  let live = null;
  let known = null;
  let knownWorkspace = null;
  const deliveryBinding = host.activeTools().some((name) => name.startsWith("mcp__linear_")) ? captureTools(host.activeTools()) : null;
  let loading = null;
  let unavailable = null;
  let disposed = false;
  let writeRevoked = false;
  const modelOption = (model) => model ? { model } : {};
  const registryOption = (registry) => registry ? { modelRegistry: registry } : {};
  const deny = (reason) => ({
    allow: false,
    reason,
    runId: live?.runId ?? "",
    revision: null,
    ownerEpoch: null
  });
  async function load() {
    try {
      const sessionId = host.sessionId();
      if (!sessionId) {
        unavailable = "session-identity-unavailable";
        return;
      }
      const located = locateRun(await inspectRepository(host.cwd())) ?? known;
      if (!located) {
        unavailable = "run-not-initialized";
        return;
      }
      const binding = { processInstanceId: host.processInstanceId, sessionId, contextEpoch: 0 };
      const kernel = await openRun({
        repo: located.repo,
        runId: located.runId,
        buildId: host.buildId,
        mode: "owner",
        binding
      });
      if (disposed) {
        await kernel.dispose();
        return;
      }
      live = { kernel, binding, runId: located.runId };
      known = { repo: located.repo, runId: located.runId };
    } catch (error) {
      unavailable = writeRevoked ? "context-cleared" : error instanceof RunBusyError ? "run-owned-elsewhere" : "run-state-unavailable";
    }
  }
  function ensureLoaded() {
    if (live || unavailable || disposed) return null;
    loading ??= load();
    return loading;
  }
  const gitHead = (worktree) => {
    const result = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"]);
    if (result.exitCode !== 0) throw new Error(`cannot read HEAD in ${worktree}: ${result.stderr.toString().slice(-300)}`);
    return result.stdout.toString().trim();
  };
  const projectVocabulary = async (worktree, entryPaths) => {
    const read = async (path) => {
      try {
        return await Bun.file(join4(worktree, path)).text();
      } catch {
        return "";
      }
    };
    const listMarkdown = async (directory) => existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".md")).sort().slice(0, 40) : [];
    const standards = (await read("CODING_STANDARDS.md")).slice(0, 8e3);
    const standardsBlock = standards.trim() ? `Standards:
${standards}

` : "";
    if (entryPaths && entryPaths.length > 0) {
      const blocks = [];
      for (const entry of entryPaths) {
        const target = join4(worktree, entry);
        if (existsSync(target)) {
          const entryStat = await statPath(target);
          if (entryStat.isDirectory()) {
            const names = await listMarkdown(target);
            const readme = (await read(join4(entry, "README.md"))).slice(0, 4e3);
            if (names.length > 0) blocks.push(`ADR directory ${entry} \u2014 decisions on record: ${names.join(", ")}${readme.trim() ? `
${readme}` : ""}`);
          } else {
            const text = (await read(entry)).slice(0, 8e3);
            if (text.trim()) blocks.push(`${entry}:
${text}`);
          }
        }
      }
      if (blocks.length > 0) {
        return `${standardsBlock}Project context:
${blocks.join("\n\n")}
Flag any term that contradicts the vocabulary above, any decision this change contradicts, and any standards violation.

`;
      }
      return standardsBlock.trim() ? standardsBlock : "";
    }
    const glossary = (await read("GLOSSARY.md")).slice(0, 8e3);
    const adrDirectory = join4(worktree, "docs", "adr");
    const adrs = existsSync(adrDirectory) ? readdirSync(adrDirectory).filter((name) => name.endsWith(".md")).sort().slice(0, 40) : [];
    const standardsText = [await read("CODING_STANDARDS.md"), await read("CONTRIBUTING.md")].find((text) => text.trim())?.slice(0, 8e3) ?? "";
    if (!glossary && adrs.length === 0 && !standardsText) return "";
    return `Project vocabulary:
${glossary || "(no GLOSSARY.md)"}
Decisions on record (docs/adr): ${adrs.join(", ") || "none"}
` + (standardsText ? `Standards:
${standardsText}
` : "(no CODING_STANDARDS.md or CONTRIBUTING.md)\n") + "Flag any term that contradicts the glossary, any decision this change contradicts, and any standards violation.\n\n";
  };
  const gitText = async (worktree, command) => {
    const result = Bun.spawn(["git", "-C", worktree, ...command], { stdout: "pipe", stderr: "pipe" });
    const [stdout, , code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
    if (code !== 0) throw new Error(`git ${command[0]} failed in ${worktree}`);
    return stdout;
  };
  const syncRun = async () => {
    if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
    const view = live.kernel.inspect();
    const unresolved = view.operations.filter((operation2) => operation2.status === "dispatched" || operation2.status === "unknown");
    if (unresolved.length > 0) {
      if (unresolved.some((operation2) => operation2.type !== "git-sync")) {
        throw new Error(`${unresolved.length} effect(s) are unsettled and are not a sync; reconcile them first.`);
      }
      const gitDir = view.git.worktreeGitDir;
      const baseRef = await gitText(view.worktree, ["ls-remote", "--heads", view.git.remote, view.git.prBase]).catch(() => "");
      const baseSha = /^([0-9a-f]{40})\s/m.exec(baseRef)?.[1] ?? null;
      const head = gitHead(view.worktree);
      let descends = false;
      if (baseSha && head !== baseSha) {
        descends = await Bun.spawn(
          ["git", "-C", view.worktree, "merge-base", "--is-ancestor", baseSha, head],
          { stdout: "ignore", stderr: "ignore" }
        ).exited === 0;
      }
      const decision = reconcileInterruptedSync({
        rebasing: existsSync(join4(gitDir, "rebase-merge")) || existsSync(join4(gitDir, "rebase-apply")),
        porcelain: await gitText(view.worktree, ["status", "--porcelain"]),
        head,
        integrationSha: view.currentIntegrationSha,
        baseSha,
        headDescendsFromBase: descends
      });
      if (decision.kind === "blocked") throw new Error(`the interrupted sync cannot be settled automatically (${decision.reason}); inspect it before continuing.`);
      for (const operation2 of unresolved) {
        await live.kernel.apply({
          kind: "operation.settle",
          operationId: operation2.id,
          outcome: decision.kind === "applied" ? "applied" : "not-applied",
          receipt: {
            target: operation2.target,
            intentDigest: operation2.intentDigest,
            reference: decision.kind === "applied" ? baseSha : "reconciled-clean-tree"
          }
        }, live.binding);
      }
      if (decision.kind === "applied") {
        await live.kernel.apply({ kind: "sync", previousIntegrationSha: view.currentIntegrationSha, newIntegrationSha: baseSha }, live.binding);
        host.notify(`reconciled ${unresolved.length} interrupted sync operation(s): the rebase had applied onto ${baseSha.slice(0, 12)}.`);
      } else {
        host.notify(`reconciled ${unresolved.length} interrupted sync operation(s) from a clean worktree; nothing was applied.`);
      }
    }
    const operation = {
      id: `sync-${view.revision + 1}`,
      type: "git-sync",
      target: view.git.prBase,
      intentDigest: createHash5("sha256").update(`${view.runId}:${view.currentIntegrationSha}`).digest("hex")
    };
    await live.kernel.apply({ kind: "operation.prepare", operation }, live.binding);
    await live.kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, live.binding);
    if (!known) throw new Error("The run's worktree is not bound in this session.");
    const result = await sync({ repo: { ...known.repo, currentIntegrationSha: view.currentIntegrationSha }, operationId: operation.id });
    if (result.outcome === "synced" || result.outcome === "unchanged") {
      await live.kernel.apply({
        kind: "operation.settle",
        operationId: operation.id,
        outcome: result.outcome === "unchanged" ? "not-applied" : "applied",
        receipt: {
          target: view.git.prBase,
          intentDigest: operation.intentDigest,
          reference: result.outcome === "unchanged" ? `unchanged:${view.currentIntegrationSha}` : result.newIntegrationSha
        }
      }, live.binding);
      if (result.outcome === "synced") {
        await live.kernel.apply({
          kind: "sync",
          previousIntegrationSha: result.previousIntegrationSha,
          newIntegrationSha: result.newIntegrationSha
        }, live.binding);
      }
      host.notify(result.outcome === "unchanged" ? `${live.runId} is already on the current ${view.git.prBase} base` : `synced ${live.runId} onto ${result.newIntegrationSha.slice(0, 12)}; ${result.detail}`);
    } else {
      await live.kernel.apply({
        kind: "operation.settle",
        operationId: operation.id,
        outcome: "not-applied",
        receipt: { target: view.git.prBase, intentDigest: operation.intentDigest, reference: result.outcome }
      }, live.binding);
      throw new Error(`sync ${result.outcome}: ${result.detail}`);
    }
  };
  return {
    async lifecycle(event) {
      if (event.type === "session_start") await ensureLoaded();
      if (event.type === "session_clear") {
        writeRevoked = true;
        if (!live) unavailable = "context-cleared";
        host.notify("writes revoked after /clear: re-authorize with /feat-flow-start");
      }
    },
    context() {
      if (!live) {
        return {
          located: false,
          reason: unavailable ?? "run-loading",
          runId: null,
          revision: null,
          phase: null,
          readiness: null,
          waitingReason: null,
          ownerStatus: null,
          currentTask: null,
          approvedScopeDigest: null,
          issue: null,
          unresolvedOperations: 0,
          unknownOperations: 0,
          openBoundaries: [],
          planSlices: 0
        };
      }
      const view = live.kernel.inspect();
      return {
        located: true,
        reason: null,
        runId: view.runId,
        revision: view.revision,
        phase: view.phase,
        issue: view.issue,
        readiness: view.readiness,
        waitingReason: view.waitingReason,
        ownerStatus: view.ownerStatus,
        currentTask: view.currentTask,
        approvedScopeDigest: view.approvedScope?.digest ?? null,
        unresolvedOperations: view.operations.filter((operation) => operation.status === "dispatched").length,
        unknownOperations: view.operations.filter((operation) => operation.status === "unknown").length,
        openBoundaries: view.grilling?.open ?? [],
        planSlices: view.plan?.slices.length ?? 0
      };
    },
    beforeTool(call) {
      const effect = effectOf(call.toolName);
      if (effect === "read") return { allow: true, reason: "allowed", runId: live?.runId ?? "", revision: null, ownerEpoch: null };
      if (writeRevoked) return deny("context-cleared");
      if (!call.toolCallId) return deny("unattributed-tool-call");
      if (!live) {
        ensureLoaded();
        return deny(unavailable ?? "run-loading");
      }
      return live.kernel.admit({ toolCallId: call.toolCallId, effect }, live.binding);
    },
    async command(name, arguments_) {
      if (name === "start") {
        if (!live && writeRevoked) {
          const confirmed = await host.confirm(
            "Re-authorize this session after /clear?",
            "Clearing the conversation revoked this session's write authority. Approving only re-opens the saved run; it grants no merge, publication or delivery."
          );
          if (!confirmed) throw new Error("Cancelled: this session stays unauthorized after the clear.");
          writeRevoked = false;
          unavailable = null;
          await load();
          const reopened = /* @__PURE__ */ (() => live)();
          host.notify(reopened ? `re-opened ${reopened.kernel.inspect().runId} after the clear; writes still follow its approved scope.` : "no run to reopen after the clear.");
          return;
        }
        if (live && writeRevoked) {
          const confirmed = await host.confirm(
            "Re-authorize this session after /clear?",
            "Clearing the conversation revoked this session's write authority. Approving restores write access only for the already approved scope; it grants no merge, publication or delivery."
          );
          if (!confirmed) throw new Error("Cancelled: this session stays unauthorized after the clear.");
          const current = live.kernel.inspect();
          const scope = current.approvedScope;
          if (current.readiness === "blocked" && scope) {
            await live.kernel.apply({
              kind: "owner.authorize",
              source: "native-ui",
              approved: true,
              runId: live.runId,
              digest: scope.digest,
              candidateRevision: scope.revision,
              ownerEpoch: current.ownerEpoch
            }, live.binding);
          }
          writeRevoked = false;
          host.notify(`re-authorized ${live.runId} after the clear.`);
          return;
        }
        if (live) {
          const view2 = live.kernel.inspect();
          const scope = view2.approvedScope;
          if (view2.readiness !== "blocked" || !scope) throw new Error(`This session already owns run ${live.runId}.`);
          const confirmed = await host.confirm(
            `Authorize this session as owner of ${live.runId}?`,
            `The saved design is unchanged: scope ${scope.scope}. Approving here only lets this session continue that approved work; it grants no merge, publication or delivery, and an unresolved effect still blocks writes.`
          );
          if (!confirmed) throw new Error("Cancelled: this session stays unauthorized for the run.");
          await live.kernel.apply({
            kind: "owner.authorize",
            source: "native-ui",
            approved: true,
            runId: live.runId,
            digest: scope.digest,
            candidateRevision: scope.revision,
            ownerEpoch: live.kernel.inspect().ownerEpoch
          }, live.binding);
          host.notify(`authorized this session for ${live.runId}; nothing was created.`);
          return;
        }
        const methods = await resolveMethods(dependenciesCore);
        if (methods.guidance) throw new Error(methods.guidance);
        const model = await host.modelStatus();
        if (!model.ready) throw new Error(model.guidance ?? `No usable model: ${model.reason}.`);
        const input = arguments_.trim();
        const bare = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(input);
        const url = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+)-(\d+)(?:[/?#].*)?$/.exec(input);
        const issueMatch = bare ?? url;
        const slug = issueMatch ? `${issueMatch[1].toLowerCase()}-${issueMatch[2]}` : input;
        const boundIssue = issueMatch ? `${issueMatch[1]}-${issueMatch[2]}` : null;
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error("start needs a lowercase requirement slug or a Linear identifier, for example /feat-flow-start desk-1234.");
        const location = await inspectRepository(host.cwd());
        if (boundIssue) {
          const key = process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE === "1" ? null : await resolveLinearKey();
          if (key) {
            const described = await linearClient(key).describe(boundIssue).catch(() => null);
            if (!described) throw new Error(`${boundIssue} is not readable with the available Linear credential.`);
            const defaults2 = readProject(location.commonDir)?.defaults;
            if (defaults2 && described.teamId !== defaults2.linear.teamId) {
              throw new Error(`${described.identifier} belongs to another team than the project's configured Linear team.`);
            }
          } else {
            host.notify(`bound ${boundIssue} without a Linear read: no credential is available (or the flow is offline) to verify it now.`);
          }
        }
        const existing = locateRun(location) ?? known;
        if (existing) {
          const binding2 = { processInstanceId: host.processInstanceId, sessionId: host.sessionId(), contextEpoch: 0 };
          const kernel2 = await openRun({ repo: existing.repo, runId: existing.runId, buildId: host.buildId, mode: "owner", binding: binding2 });
          live = { kernel: kernel2, binding: binding2, runId: existing.runId };
          known = { repo: existing.repo, runId: existing.runId };
          const view2 = kernel2.inspect();
          const scope = view2.approvedScope;
          if (view2.readiness === "blocked" && scope) {
            const confirmed = await host.confirm(
              `Authorize this session as owner of ${existing.runId}?`,
              `The saved design is unchanged: scope ${scope.scope}. Approving here only lets this session continue that approved work; it grants no merge, publication or delivery, and an unresolved effect still blocks writes.`
            );
            if (!confirmed) {
              await kernel2.dispose();
              live = null;
              throw new Error("Cancelled: this session stays unauthorized for the run.");
            }
            await kernel2.apply({
              kind: "owner.authorize",
              source: "native-ui",
              approved: true,
              runId: existing.runId,
              digest: scope.digest,
              candidateRevision: scope.revision,
              ownerEpoch: kernel2.inspect().ownerEpoch
            }, binding2);
          }
          host.notify(`resumed ${existing.runId}; nothing was created.`);
          return;
        }
        const defaults = readProject(location.commonDir)?.defaults;
        if (!defaults) throw new Error("This project has no omp-feat-flow defaults; record git.remote, git.startRef and git.prBase before starting.");
        const worktreeRoot = isAbsolute(defaults.git.worktreeRoot) ? defaults.git.worktreeRoot : join4(location.repo, "..", defaults.git.worktreeRoot);
        const targetWorktree = join4(worktreeRoot, slug);
        const repo = await prepare({
          repo: location.repo,
          remote: defaults.git.remote,
          startRef: defaults.git.startRef,
          prBase: defaults.git.prBase,
          runId: slug,
          branch: `feat/${slug}`,
          worktree: targetWorktree
        });
        const binding = { processInstanceId: host.processInstanceId, sessionId: host.sessionId(), contextEpoch: 0 };
        let kernel;
        try {
          kernel = await RunKernel.create({ repo, runId: slug, buildId: host.buildId, mode: "owner", binding });
        } catch (error) {
          const rollback = async () => {
            const run = (command) => Bun.spawn(["git", "-C", location.repo, ...command], { stdout: "ignore", stderr: "ignore" }).exited;
            await run(["worktree", "remove", "--force", targetWorktree]);
            await run(["branch", "-D", `feat/${slug}`]);
            await run(["update-ref", "-d", `refs/omp-feat-flow/start/${slug}`]);
          };
          await rollback().catch(() => {
          });
          throw error;
        }
        if (boundIssue) await kernel.apply({ kind: "bindIssue", issue: boundIssue }, binding);
        live = { kernel, binding, runId: slug };
        known = { repo, runId: slug };
        const workspace = await ensureWorkspace(
          { runId: slug, worktree: repo.worktree, startCommand: "omp" },
          host.workspace.enabled ? host.workspace.run ?? defaultRun : async () => ({ code: 127, stdout: "", stderr: "cmux disabled" })
        );
        knownWorkspace = workspace;
        await kernel.apply({ kind: "workspace.record", workspace: {
          workspaceId: workspace.workspaceId,
          verified: workspace.verified,
          continuation: workspace.continuation,
          handoff: workspace.handoff
        } }, binding);
        host.notify(`run ${slug} created at ${repo.worktree}; workspace ${workspace.handoff === "switched" ? `switched to ${workspace.workspaceId}` : "not switched"}. Continue with: ${workspace.continuation}. The tracking issue is not created yet.`);
        return;
      }
      if (name === "approve") {
        await ensureLoaded();
        if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
        const before = live.kernel.inspect();
        const knowledge = before.knowledgeCandidate;
        if (knowledge && !before.candidate) {
          const root = resolve4(before.worktree);
          const proposal = await proposeKnowledge({ root, candidates: [knowledge] });
          if (!proposal.change) throw new Error(`No knowledge change to approve: ${proposal.reason}`);
          const diffText = proposal.changes.map((change) => `## ${change.path} (${change.status})
${change.diff.join("\n")}`).join("\n\n");
          const packetText = `Knowledge correction for ${live.runId}
Reason: ${knowledge.reason}

${diffText}`;
          const cold2 = await runHelper(host.helperSdk(), {
            kind: "cold-read",
            cwd: before.worktree,
            prompt: coldReadPrompt(approvalPacket({
              runId: live.runId,
              candidateRevision: before.candidateRevision,
              content: packetText,
              scope: knowledge.path,
              base: before.currentIntegrationSha
            })),
            ...modelOption(host.model()),
            ...registryOption(host.modelRegistry()),
            binding: { taskId: live.runId, epoch: before.ownerEpoch, snapshotDigest: before.configDigest }
          });
          if (/^\s*NOT\b/i.test(cold2.text)) throw new Error(`the knowledge packet was not answerable to a cold reader: ${cold2.text.slice(0, 400)}`);
          const [title2, ...rest2] = packetText.split("\n");
          const confirmed2 = await host.confirm(
            title2 ?? "Approve this knowledge correction?",
            `${rest2.join("\n")}

Approving writes exactly this file content and nothing else.`
          );
          if (!confirmed2) throw new Error("Cancelled: the knowledge file is untouched.");
          const after2 = live.kernel.inspect();
          if (after2.knowledgeCandidate?.path !== knowledge.path || after2.candidate) {
            throw new Error("The knowledge candidate changed while you were deciding; approve it again.");
          }
          await live.kernel.apply({
            kind: "approve",
            source: "native-ui",
            approved: true,
            runId: live.runId,
            digest: createHash5("sha256").update(JSON.stringify(knowledge)).digest("hex"),
            candidateRevision: 0,
            ownerEpoch: after2.ownerEpoch
          }, live.binding);
          host.notify(`applied the knowledge correction to ${knowledge.path}; nothing else was granted.`);
          return;
        }
        const candidate = before.candidate;
        if (!candidate) throw new Error("There is no candidate proposal to approve.");
        if (before.readiness !== "ready") throw new Error(`Recovery is not ready (${before.waitingReason ?? before.readiness}); approve is refused.`);
        const material = JSON.parse(readFileSync2(candidate.contentPath, "utf8"));
        const packet = approvalPacket({
          runId: live.runId,
          candidateRevision: candidate.revision,
          content: String(material.content),
          scope: String(material.scope),
          base: before.currentIntegrationSha
        });
        const rendered = renderPacket(packet);
        const cold = await runHelper(host.helperSdk(), {
          kind: "cold-read",
          cwd: before.worktree,
          prompt: coldReadPrompt(packet),
          ...modelOption(host.model()),
          ...registryOption(host.modelRegistry()),
          binding: { taskId: live.runId, epoch: before.ownerEpoch, snapshotDigest: before.configDigest }
        });
        if (/^\s*NOT\b/i.test(cold.text)) throw new Error(`the packet was not answerable to a cold reader: ${cold.text.slice(0, 400)}`);
        const [title, ...rest] = rendered.split("\n");
        const confirmed = await host.confirm(title ?? "Approve this candidate?", `${rest.join("\n")}

Cold read: ${cold.text.slice(0, 400)}`);
        if (!confirmed) throw new Error("Cancelled: implementation stays closed.");
        const after = live.kernel.inspect();
        if (after.readiness !== "ready" || after.candidate?.digest !== candidate.digest || after.candidate.revision !== candidate.revision) {
          throw new Error("The candidate changed while you were deciding; approve the current one again.");
        }
        await live.kernel.apply({
          kind: "approve",
          source: "native-ui",
          approved: true,
          runId: live.runId,
          digest: candidate.digest,
          candidateRevision: candidate.revision,
          ownerEpoch: after.ownerEpoch
        }, live.binding);
        host.notify(`approved ${live.runId} revision ${candidate.revision}.`);
        return;
      }
      if (name === "sync") {
        await syncRun();
        return;
      }
      if (name === "finish") {
        if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
        const view2 = live.kernel.inspect();
        const unresolved = view2.operations.filter((operation) => operation.status === "dispatched" || operation.status === "unknown");
        if (unresolved.length > 0) throw new Error(`Refusing to finish: ${unresolved.length} effect(s) are unsettled; reconcile them first.`);
        await syncRun();
        const synced = live.kernel.inspect();
        const scope = synced.approvedScope;
        if (!scope) throw new Error("finish needs an approved scope before it can deliver.");
        const head = gitHead(synced.worktree);
        const identity = {
          worktree: synced.worktree,
          base: synced.currentIntegrationSha,
          head,
          candidateDigest: scope.digest,
          configDigest: synced.configDigest,
          inputRevision: synced.inputRevision
        };
        const currentReview = synced.proofs.some((proof) => proof.kind === "review" && proof.worktree === identity.worktree && proof.base === identity.base && proof.head === identity.head && proof.candidateDigest === identity.candidateDigest && proof.configDigest === identity.configDigest && proof.inputRevision === identity.inputRevision);
        if (!currentReview) {
          const diff = await gitText(synced.worktree, ["diff", "--stat", `${identity.base}..${identity.head}`]);
          const patch = await gitText(synced.worktree, ["diff", `${identity.base}..${identity.head}`]);
          const materials = join4(synced.commonDir, "omp-feat-flow", "runs", synced.runId, "materials");
          await mkdir3(materials, { recursive: true, mode: 448 });
          const patchPath = join4(materials, `review-${identity.head.slice(0, 12)}.patch`);
          await Bun.write(patchPath, patch);
          const vocabulary = await projectVocabulary(synced.worktree, synced.project?.defaults.knowledge.entryPaths);
          const review = await runHelper(host.helperSdk(), {
            kind: "review",
            cwd: synced.worktree,
            prompt: `Review this change against the approved scope: ${scope.scope}.

${vocabulary}
Changed files:
${diff.slice(0, 4e3)}

Diff:
${patch.slice(0, 6e4)}

Answer with exactly ACCEPT on the first line if the change matches the scope, otherwise start your reply with REJECT.`,
            ...modelOption(host.model()),
            ...registryOption(host.modelRegistry()),
            binding: { taskId: synced.runId, epoch: synced.ownerEpoch, snapshotDigest: synced.configDigest }
          });
          const verdict = review.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
          const twoAxes = /##\s*Standards\b/.test(review.text) && /##\s*Spec\b/.test(review.text);
          if (verdict !== "ACCEPT" || !twoAxes) {
            throw new Error(`independent review did not accept (verdict ${verdict || "empty"}, axes ${twoAxes ? "present" : "missing"}): ${review.text.slice(0, 500)}`);
          }
          await live.kernel.apply({ kind: "proof.record", proof: {
            kind: "review",
            name: "independent",
            ...identity,
            detail: review.text.slice(0, 2e3)
          } }, live.binding);
        }
        if (synced.phase !== "delivery") {
          await live.kernel.apply({ kind: "beginDelivery" }, live.binding);
          host.notify(`independent review accepted; ${live.runId} entered delivery.`);
        }
        const delivering = live.kernel.inspect();
        const issue = delivering.issue;
        if (!issue) throw new Error("delivery needs the one requirement issue; bind it before finishing (no issue is created implicitly).");
        const defaults = delivering.project?.defaults ?? readProject(delivering.commonDir)?.defaults;
        if (!defaults) throw new Error("delivery needs the project defaults: repository, Linear team and status mapping.");
        const linearKey = await resolveLinearKey();
        const injected = host.deliveryPorts?.({ worktree: delivering.worktree, repository: defaults.github.repository, linearKey });
        if (!injected && !linearKey) throw new Error("no Linear credential is available; delivery is blocked instead of being faked.");
        const ports = injected ?? {
          git: async (command) => {
            const result = Bun.spawnSync(["git", "-C", delivering.worktree, ...command]);
            return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
          },
          github: githubClient(defaults.github.repository),
          linear: linearClient(linearKey)
        };
        const delivered = await deliver({
          binding: {
            captured: deliveryBinding ?? captureTools(host.activeTools()),
            current: host.activeTools(),
            expect: { server: "linear", tool: "get_issue" }
          },
          runId: delivering.runId,
          worktree: delivering.worktree,
          remote: delivering.git.remote,
          prBase: delivering.git.prBase,
          branch: delivering.branch,
          head,
          integrationBase: delivering.currentIntegrationSha,
          issue,
          reviewState: defaults.linear.statusMapping.inReview,
          title: `${delivering.branch} (${delivering.runId})`,
          proofs: delivering.proofs,
          current: {
            worktree: delivering.worktree,
            base: delivering.currentIntegrationSha,
            head,
            candidateDigest: delivering.approvedScope?.digest ?? "",
            configDigest: delivering.configDigest,
            inputRevision: delivering.inputRevision
          }
        }, ports);
        if (delivered.outcome !== "delivered") throw new Error(`delivery ${delivered.outcome}: ${delivered.detail}`);
        host.notify(`delivered ${issue} with PR #${delivered.pr?.number}; Linear ${delivered.linear?.identifier} ${delivered.linear?.state}.`);
        const run = host.workspace.enabled ? host.workspace.run ?? defaultRun : async () => ({ code: 127, stdout: "", stderr: "cmux disabled" });
        const owned = knownWorkspace?.workspaceId ? { workspaceId: knownWorkspace.workspaceId, verified: knownWorkspace.verified, continuation: knownWorkspace.continuation } : live.kernel.inspect().workspace;
        if (owned?.workspaceId && owned.verified) {
          const id = owned.workspaceId;
          let closed = false;
          for (let attempt = 0; attempt < 20 && !closed; attempt += 1) {
            if (attempt > 0) await new Promise((resolve5) => setTimeout(resolve5, 150));
            const result = await run("cmux", ["workspace", "close", id]);
            if (result.code === 0) closed = true;
          }
          if (!closed) throw new Error(`Delivery succeeded, but cleanup failed: the owned workspace ${id} could not be closed. The PR, branch and worktree are untouched; close it with: cmux workspace close ${id}`);
          await live.kernel.apply({ kind: "workspace.record", workspace: null }, live.binding);
          host.notify(`closed ${id} for ${live.runId}; the PR, branch and worktree are untouched.`);
        } else {
          host.notify(`no owned workspace to close for ${live.runId}; continue with: ${owned?.continuation ?? continuationCommand(view2.worktree, view2.runId)}`);
        }
        knownWorkspace = null;
        return;
      }
      if (name === "update") {
        const methods = await resolveMethods(dependenciesCore);
        const lines2 = methods.methods.map((method) => `${method.name}: ${method.status}${method.update.permitted ? " (update permitted)" : ` (preserved: ${method.update.reason})`}`);
        const installed = await host.installedRelease();
        const unresolved = live ? live.kernel.inspect().operations.filter((operation) => operation.status === "dispatched" || operation.status === "unknown").length : 0;
        const assessment = inspectUpdate({ loadedBuildId: "5ff6f2bac4726080a8d3ef225a137f1a9faaf2f34695402a5b1156f6e68cd906", installed, unresolvedEffects: unresolved });
        const text = `${lines2.join("; ")}. Source ${methods.ref?.slice(0, 12) ?? "unknown"}; nothing was downloaded or overwritten. Build: ${assessment.relation} (${assessment.detail}).`;
        host.notify(text);
        return;
      }
      await ensureLoaded();
      const view = this.context();
      const workspaceSuffix = knownWorkspace ? `; workspace ${knownWorkspace.workspaceId ?? "none"} (${knownWorkspace.handoff})` : "";
      if (view.located && live) {
        const run = live.kernel.inspect();
        const head = (() => {
          try {
            return gitHead(run.worktree);
          } catch {
            return run.currentIntegrationSha;
          }
        })();
        const stale = deliveryBlockers(run.proofs, {
          worktree: run.worktree,
          base: run.currentIntegrationSha,
          head,
          candidateDigest: run.approvedScope?.digest ?? "",
          configDigest: run.configDigest,
          inputRevision: run.inputRevision
        });
        const installed = await host.installedRelease();
        const build = inspectUpdate({ loadedBuildId: "5ff6f2bac4726080a8d3ef225a137f1a9faaf2f34695402a5b1156f6e68cd906", installed, unresolvedEffects: 0 });
        host.notify(`baseline ${run.currentIntegrationSha.slice(0, 12)} (start ${run.startSha.slice(0, 12)}), head ${head.slice(0, 12)}, issue ${run.issue ?? "unbound"}, proofs ${run.proofs.length}${stale.length ? ` (${stale.length} stale)` : ""}, build ${build.relation}`);
        host.notify(`next: ${run.knowledgeCandidate ? `approve the knowledge correction for ${run.knowledgeCandidate.path}` : !run.approvedScope ? "propose and approve a plan" : run.phase === "delivery" ? "finish to deliver and clean up" : "implement, then finish"}`);
      }
      const revokedSuffix = writeRevoked ? "; writes revoked after /clear: re-authorize with /feat-flow-start" : "";
      host.notify((view.located ? `run ${view.runId} r${view.revision} ${view.phase} ${view.readiness}${view.waitingReason ? ` (${view.waitingReason})` : ""}, owner ${view.ownerStatus}, approved ${view.approvedScopeDigest ? "yes" : "no"}` : `no run: ${view.reason}`) + revokedSuffix);
      if (view.located) host.notify(`${view.runId}${workspaceSuffix}`);
    },
    async request(intent, requestId) {
      await ensureLoaded();
      if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
      return live.kernel.apply(
        { kind: "request.submit", requestId, expectedRevision: live.kernel.inspect().revision, intent },
        live.binding
      );
    },
    async rebindSession() {
      await loading;
      await live?.kernel.dispose();
      live = null;
      loading = null;
      unavailable = null;
    },
    async dispose() {
      disposed = true;
      await loading;
      await live?.kernel.dispose();
      live = null;
    }
  };
}

// src/grilling.ts
var BOUNDARY_CATEGORIES = ["goals", "non-goals", "business-boundary", "error-path", "acceptance"];
var DECISIONS_HEADING = /^##\s+Decisions\s*$/i;
var RULE = /^[-*]\s+([a-z-]+)\s*:\s*(.+)$/i;
function readPrdDecisions(markdown) {
  const decisions = [];
  let inside = false;
  for (const line of markdown.split("\n")) {
    if (DECISIONS_HEADING.test(line.trim())) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^##\s+/.test(line)) break;
    const match = RULE.exec(line.trim());
    if (!match) continue;
    const category = match[1];
    if (!BOUNDARY_CATEGORIES.includes(category)) continue;
    decisions.push({ category, answer: match[2].trim() });
  }
  return decisions;
}
function openBoundaries(decided, _facts) {
  const answered = new Set(decided.map((decision) => decision.category));
  return BOUNDARY_CATEGORIES.filter((category) => !answered.has(category)).map((category) => ({ category }));
}
function grillFromPrd(markdown, facts) {
  const decided = readPrdDecisions(markdown);
  return { decided, open: openBoundaries(decided, facts) };
}
function grillFromConversation(answers, facts) {
  if (!Array.isArray(answers)) throw new Error("Boundary answers must be a JSON array of {category, answer} objects.");
  const seen = /* @__PURE__ */ new Set();
  for (const answer of answers) {
    if (!BOUNDARY_CATEGORIES.includes(answer.category)) throw new Error(`Unknown boundary category: ${answer.category}`);
    if (seen.has(answer.category)) throw new Error(`Duplicate boundary answer for ${answer.category}.`);
    if (!answer.answer.trim()) throw new Error(`The ${answer.category} answer is empty.`);
    seen.add(answer.category);
  }
  return { decided: answers, open: openBoundaries(answers, facts) };
}

// src/index.ts
function recordedAnswers(value) {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object" && "decided" in value && Array.isArray(value.decided)) {
    return value.decided;
  }
  throw new Error("boundariesPath must hold a JSON array of {category, answer} or an object with a decided array.");
}
function parseJson(text, field) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${field} must be valid JSON.`);
  }
}
var BUILD_ID = "5ff6f2bac4726080a8d3ef225a137f1a9faaf2f34695402a5b1156f6e68cd906";
function usableCredential(key) {
  if (!key || key === "N/A") return false;
  return /^[A-Z][A-Z0-9_]{2,}$/.test(key) ? Boolean(process.env[key]) : true;
}
function featFlow(pi) {
  const processInstanceId = randomUUID2();
  let sessionId = "";
  let context = null;
  let flow = null;
  let loading = null;
  const modelStatus = async () => {
    if (!context) return { ready: false, reason: "session-not-started", provider: null, model: null, guidance: null };
    const current = context.models.current();
    if (!current) return {
      ready: false,
      reason: "no-model-selected",
      provider: null,
      model: null,
      guidance: "No model is selected. Run /model to pick a model before starting a requirement."
    };
    const key = await context.modelRegistry.getApiKeyForProvider(current.provider);
    if (!usableCredential(key)) return {
      ready: false,
      reason: "credential-missing",
      provider: current.provider,
      model: current.id,
      guidance: `No credential is available for ${current.provider}/${current.id}. Run /login for ${current.provider}, or /model to choose an authenticated model; this flow does not retry or fall back to another model.`
    };
    return { ready: true, reason: "ready", provider: current.provider, model: current.id, guidance: null };
  };
  const controller = () => {
    flow ??= createFlow({
      cwd: () => process.cwd(),
      sessionId: () => sessionId,
      processInstanceId,
      buildId: BUILD_ID,
      notify: (text) => {
        pi.logger.info(text);
        if (context?.hasUI) context.ui.notify(text);
      },
      modelStatus,
      workspace: { enabled: process.env.OMP_FEAT_FLOW_CMUX === "1" },
      activeTools: () => pi.getActiveTools(),
      helperSdk: () => pi.pi,
      modelRegistry: () => context?.modelRegistry,
      model: () => context?.models.current(),
      installedRelease: async () => {
        try {
          const release = JSON.parse(await readFile3(new URL("./release.json", import.meta.url), "utf8"));
          return typeof release.buildId === "string" && typeof release.version === "string" ? { buildId: release.buildId, version: release.version } : null;
        } catch {
          return null;
        }
      },
      confirm: (title, message) => {
        if (!context) throw new Error("The session UI is not available yet.");
        return context.ui.confirm(title, message);
      }
    });
    return flow;
  };
  const start = async (ctx) => {
    context = ctx;
    const nextSessionId = ctx.sessionManager.getSessionId();
    if (flow && sessionId && sessionId !== nextSessionId) {
      await flow.rebindSession();
      loading = null;
    }
    sessionId = nextSessionId;
    loading ??= controller().lifecycle({ type: "session_start" }).then(() => {
      const view = controller().context();
      if (!view.located) return;
      pi.sendMessage(
        { customType: "feat-flow-recovery", content: [{ type: "text", text: `feat-flow-recovery: ${recoveryReceipt(view)}` }] },
        { deliverAs: "nextTurn" }
      );
    });
    return loading;
  };
  pi.on("session_start", async (_event, ctx) => {
    await start(ctx);
  });
  pi.on("session_clear", async () => {
    flow?.lifecycle({ type: "session_clear" }).catch(() => {
    });
    await flow?.rebindSession();
  });
  pi.on("session_compact", () => {
    const view = controller().context();
    pi.logger.info(`feat-flow session_compact: located=${view.located} reason=${view.reason ?? "none"}`);
    if (!view.located) return;
    pi.sendMessage(
      { customType: "feat-flow-recovery", content: [{ type: "text", text: `feat-flow-recovery: ${recoveryReceipt(view)}` }] },
      { deliverAs: "nextTurn" }
    );
  });
  pi.on("session_shutdown", async () => {
    await flow?.dispose();
    flow = null;
    loading = null;
  });
  pi.on("tool_call", (event, ctx) => {
    void start(ctx);
    const admission = controller().beforeTool({ toolCallId: event.toolCallId, toolName: event.toolName });
    if (admission.allow) return;
    pi.logger.info(`denied ${event.toolName} (${effectOf(event.toolName)}): ${admission.reason}`);
    return { block: true, reason: `feat-flow denied this ${effectOf(event.toolName)}: ${admission.reason}` };
  });
  pi.registerCommand("feat-flow-status", {
    description: flowCommandDescription("status"),
    handler: async (_args, ctx) => {
      await start(ctx);
      await controller().command("status", "");
      const view = controller().context();
      ctx.ui.notify(view.located ? `${view.runId} r${view.revision} ${view.phase} ${view.readiness}` : `no run: ${view.reason}`);
    }
  });
  pi.registerCommand("feat-flow-start", {
    description: flowCommandDescription("start"),
    handler: async (args, ctx) => {
      await start(ctx);
      try {
        await controller().command("start", args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        throw error;
      }
    }
  });
  pi.registerCommand("feat-flow-approve", {
    description: flowCommandDescription("approve"),
    handler: async (_args, ctx) => {
      await start(ctx);
      try {
        await controller().command("approve", "");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        throw error;
      }
    }
  });
  pi.registerCommand("feat-flow-sync", {
    description: flowCommandDescription("sync"),
    handler: async (_args, ctx) => {
      await start(ctx);
      try {
        await controller().command("sync", "");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        throw error;
      }
    }
  });
  pi.registerCommand("feat-flow-finish", {
    description: flowCommandDescription("finish"),
    handler: async (_args, ctx) => {
      await start(ctx);
      try {
        await controller().command("finish", "");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        throw error;
      }
    }
  });
  pi.registerCommand("feat-flow-update", {
    description: flowCommandDescription("update"),
    handler: async (_args, ctx) => {
      try {
        await controller().command("update", "");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
  });
  pi.registerTool({
    name: "feat_flow_request",
    label: "Feat Flow Request",
    // Custom tools default to "discoverable", which keeps them out of the active set.
    loadMode: "essential",
    description: "Submit one intent (a task change or a design proposal) to the current feat-flow run. Run identity, revision and approval are supplied by the host, never by this call, and this call can never approve a design.",
    parameters: pi.zod.object({
      task: pi.zod.string().min(1).optional().describe("Set the current task."),
      proposalContent: pi.zod.string().min(1).optional().describe("Proposal body for native review."),
      proposalScope: pi.zod.string().min(1).optional().describe("Files or behaviour the proposal covers."),
      prdPath: pi.zod.string().min(1).optional().describe("Existing PRD to grill for unresolved boundaries."),
      boundariesPath: pi.zod.string().min(1).optional().describe('Path to a JSON file holding {"decided":[{"category","answer"}],"open":[]} recorded from the conversation.'),
      planPath: pi.zod.string().min(1).optional().describe("Path to a JSON file holding the implementation plan."),
      knowledgePath: pi.zod.string().min(1).optional().describe("Project-relative file the run's evidence contradicts."),
      knowledgeReason: pi.zod.string().min(1).optional().describe("The concrete recurring failure that justifies the correction."),
      knowledgeProposed: pi.zod.string().optional().describe("The full corrected file content; approval stays with the human.")
    }).strict(),
    async execute(toolCallId, params) {
      const provided = [
        params.task !== void 0,
        params.proposalContent !== void 0 || params.proposalScope !== void 0,
        params.prdPath !== void 0,
        params.boundariesPath !== void 0,
        params.planPath !== void 0,
        params.knowledgePath !== void 0
      ].filter(Boolean).length;
      if (provided !== 1) throw new Error("Provide exactly one of task, proposalContent/proposalScope, prdPath, boundariesPath, planPath or knowledgePath.");
      let intent;
      if (params.task !== void 0) intent = { kind: "task", task: params.task };
      else if (params.knowledgePath !== void 0) {
        if (!params.knowledgeReason || params.knowledgeProposed === void 0) {
          throw new Error("A knowledge correction needs knowledgePath, knowledgeReason and knowledgeProposed together.");
        }
        intent = { kind: "knowledge", path: params.knowledgePath, reason: params.knowledgeReason, proposed: params.knowledgeProposed };
      } else if (params.planPath !== void 0) {
        intent = { kind: "plan", plan: parseJson(await readFile3(params.planPath, "utf8"), "planPath") };
      } else if (params.boundariesPath !== void 0 || params.prdPath !== void 0) {
        const grilled = params.prdPath !== void 0 ? grillFromPrd(await readFile3(params.prdPath, "utf8"), []) : grillFromConversation(recordedAnswers(parseJson(await readFile3(params.boundariesPath, "utf8"), "boundariesPath")), []);
        intent = { kind: "boundaries", decided: grilled.decided, open: grilled.open.map((boundary) => boundary.category) };
      } else {
        if (!params.proposalContent || !params.proposalScope) throw new Error("A proposal needs both proposalContent and proposalScope.");
        intent = { kind: "propose", content: params.proposalContent, scope: params.proposalScope };
      }
      const outcome = await controller().request(intent, toolCallId);
      const view = outcome.view;
      const detail = intent.kind === "boundaries" ? `decided: ${intent.decided.map((decision) => decision.category).join(", ") || "none"}; open: ${intent.open.join(", ") || "none"}` : intent.kind === "plan" ? `${intent.plan.slices.length} serial slices, ${intent.plan.activities.length} activities` : intent.kind === "knowledge" ? `knowledge correction pending approval: ${intent.path}` : `approved ${view.approvedScope ? "yes" : "no"}`;
      return {
        content: [{ type: "text", text: `accepted: run ${view.runId} revision ${view.revision}, phase ${view.phase}, ${detail}` }],
        details: { runId: view.runId, revision: view.revision, phase: view.phase, open: view.grilling?.open ?? null }
      };
    }
  });
}
export {
  featFlow as default
};
