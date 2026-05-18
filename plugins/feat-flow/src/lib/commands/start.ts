import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { UserPromptInput, HookOutput, UserPromptOutput } from '../types.js';
import { runPreflight, getBaseSha } from '../preflight.js';
import { writeState, writeMarker, makeInitialState, appendTransition, paths } from '../state.js';
import { contextSizeForModel, STAGES_DIR, HELPER_PATH } from '../config.js';

function slugify(text: string): string {
  const result = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // strip non-ASCII (including CJK)
    .replace(/\s+/g, '-')
    .slice(0, 40)
    .replace(/-+$/, '')
    .replace(/^-+/, '');
  return result || 'flow';     // fallback: pure CJK input → 'flow'
}

export async function handleStart(input: UserPromptInput): Promise<HookOutput> {
  const { cwd, session_id, user_prompt } = input;

  const requirement = user_prompt.replace(/^feat-flow\s+start\s*/i, '').trim();

  if (!requirement) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason:
        '请提供需求描述。\n\n用法：feat-flow start <需求描述>\n例如：feat-flow start 搭建用户登录系统',
    };
    return { hookSpecificOutput: out };
  }

  const preflight = runPreflight(cwd);
  if (!preflight.ok) {
    const out: UserPromptOutput = {
      hookEventName: 'UserPromptSubmit',
      permissionDecision: 'deny',
      permissionDecisionReason: `feat-flow start 失败\n\n${preflight.errors.join('\n\n')}`,
    };
    return { hookSpecificOutput: out };
  }

  // Initialize
  const date = new Date().toISOString().slice(0, 10);
  const flowId = `${date}-${slugify(requirement)}`;
  const baseSha = getBaseSha(cwd);

  const p = paths(cwd);
  mkdirSync(p.stateDir, { recursive: true });

  // Create flow docs dir
  const flowDocsDir = join(cwd, 'docs', 'feat-flows', flowId);
  mkdirSync(flowDocsDir, { recursive: true });

  // Write state
  const state = makeInitialState({
    flowId,
    requirement,
    baseSha,
    sessionId: session_id,
    contextSize: contextSizeForModel('claude-sonnet-4-6'),
  });
  writeState(cwd, state);
  writeMarker(cwd, flowId);
  appendTransition(cwd, `FLOW_STARTED flow_id=${flowId} base_sha=${baseSha}`);

  // Inject stage-1 document
  const stage1Doc = join(STAGES_DIR, 'stage-1.md');
  let stageContent = '';
  if (existsSync(stage1Doc)) {
    stageContent = '\n\n--- Stage 1 指令 ---\n' + readFileSync(stage1Doc, 'utf-8');
  }

  const ctx =
    `✅ feat-flow 已启动！\n\n` +
    `flow_id:   ${flowId}\n` +
    `base_sha:  ${baseSha}\n` +
    `当前阶段:  stage-1 需求确认\n` +
    `需求描述:  ${requirement}\n\n` +
    `产出文件路径：docs/feat-flows/${flowId}/design.md\n` +
    `如需了解工作流规则：${HELPER_PATH}` +
    stageContent;

  const out: UserPromptOutput = {
    hookEventName: 'UserPromptSubmit',
    additionalContext: ctx,
  };
  return {
    systemMessage: `✅ feat-flow 已启动！flow_id: ${flowId} | 进入 stage-1 需求确认`,
    hookSpecificOutput: out,
  };
}
