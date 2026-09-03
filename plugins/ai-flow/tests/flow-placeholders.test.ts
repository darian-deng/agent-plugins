import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { PLUGIN_FLOWS_DIR } from '../src/lib/flow-paths.js';
import { renderPrompt } from '../src/lib/prompt-render.js';

/**
 * Mechanical guard for the definition/instance path split.
 *
 * `{{flow_root}}` used to mean both "where the definition is" and "where the state
 * is". Those parted company when the definition moved into the plugin, and the
 * dangerous half of that split is silent: a stage prompt that writes its `signal`
 * to the DEFINITION directory drops it somewhere nothing reads and nothing reports
 * — Write does not fail, the engine simply never advances. The split was therefore
 * made in the direction where a missed rewrite is loud (a stale
 * `{{flow_root}}/references/x.md` is an ENOENT on Read), and this file closes the
 * remaining gap by refusing the quiet direction outright.
 *
 * It reads the shipped flow definitions rather than a fixture on purpose: the thing
 * being protected is the actual prose 60-odd occurrences live in.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.md')) out.push(p);
  }
  return out;
}

const FILES = walk(PLUGIN_FLOWS_DIR).map((p) => ({
  path: p,
  rel: relative(PLUGIN_FLOWS_DIR, p),
  text: readFileSync(p, 'utf-8'),
}));

/** Every `{{name}}` the engine substitutes. Anything else reaches the model raw. */
const KNOWN_PLACEHOLDERS = new Set(['project_root', 'flow_root', 'flow_def']);

/** What may follow `{{flow_root}}/` — the instance dir holds only these. */
const ANCHOR_SUBPATHS = /^(state)\//;

/** What may follow `{{flow_def}}/` — the definition dir holds only these. */
const DEF_SUBPATHS = /^(references|stages|scripts|helper\.md|preflight\.)/;

describe('flow definition placeholders', () => {
  it('uses only placeholders the engine substitutes', () => {
    const unknown: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) {
        if (!KNOWN_PLACEHOLDERS.has(m[1]!)) unknown.push(`${f.rel}: {{${m[1]}}}`);
      }
    }
    // An unsubstituted placeholder is handed to the model verbatim, and copying one
    // into Write creates a directory named `{{…}}` without erroring.
    expect(unknown).toEqual([]);
  });

  it('every known placeholder is actually substituted by renderPrompt', () => {
    const rendered = renderPrompt(
      [...KNOWN_PLACEHOLDERS].map((n) => `{{${n}}}`).join('\n'),
      '/tmp/repo',
      'grill-flow'
    );
    expect(rendered).not.toMatch(/\{\{/);
  });

  it('{{flow_root}}/… points only at the instance dir (state/)', () => {
    const wrong: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/\{\{\s*flow_root\s*\}\}\/([^\s`)"'<>,;]*)/g)) {
        if (!ANCHOR_SUBPATHS.test(m[1]!)) wrong.push(`${f.rel}: {{flow_root}}/${m[1]}`);
      }
    }
    // references/ stages/ scripts/ moved to the plugin; a leftover here reads a
    // directory the project no longer has.
    expect(wrong).toEqual([]);
  });

  it('{{flow_def}}/… points only at the definition dir, never at state/', () => {
    const wrong: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/\{\{\s*flow_def\s*\}\}\/([^\s`)"'<>,;]*)/g)) {
        if (!DEF_SUBPATHS.test(m[1]!)) wrong.push(`${f.rel}: {{flow_def}}/${m[1]}`);
      }
    }
    // This is the quiet failure the split was arranged to avoid: a signal or
    // mark-base written under the definition dir is never read and never reported.
    expect(wrong).toEqual([]);
  });

  it('the prose aliases obey the same split as the placeholders they stand for', () => {
    // Subagents get absolute paths pasted into their dispatch prompt, so references
    // spell these `<FR>` / `<FD>` instead of `{{…}}`. Same rule, same failure mode.
    const wrong: string[] = [];
    for (const f of FILES) {
      for (const m of f.text.matchAll(/<(FR|flow_root)>\/([^\s`)"'<>,;]*)/g)) {
        if (!ANCHOR_SUBPATHS.test(m[2]!)) wrong.push(`${f.rel}: <${m[1]}>/${m[2]}`);
      }
      for (const m of f.text.matchAll(/<(FD|flow_def)>\/([^\s`)"'<>,;]*)/g)) {
        if (!DEF_SUBPATHS.test(m[2]!)) wrong.push(`${f.rel}: <${m[1]}>/${m[2]}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every documented script invocation passes --flow-dir', () => {
    // Scripts ship with the plugin now, so `__dirname` no longer says which project
    // is running them. `--flow-dir` is how the model tells them; without it they
    // fall back to walking up from cwd, which cannot work from inside a ticket
    // worktree (those live outside the repository).
    const missing: string[] = [];
    for (const f of FILES) {
      for (const line of f.text.split('\n')) {
        if (!/\bnode\s+\S*scripts\/\S+\.(cjs|mjs|js)\b/.test(line)) continue;
        if (!line.includes('--flow-dir')) missing.push(`${f.rel}: ${line.trim().slice(0, 100)}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
