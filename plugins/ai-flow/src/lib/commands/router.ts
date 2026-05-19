export const VALID_COMMANDS = ['start', 'approve', 'abort', 'resume', 'status', 'help'] as const;
export type FlowCommand = (typeof VALID_COMMANDS)[number];

export function parseFlowCommand(
  prompt: string,
  knownFlows: string[]
): { flowName: string; subCmd: string; args: string } | null {
  const trimmed = prompt.trim();
  for (const flowName of knownFlows) {
    const pattern = new RegExp(`^${flowName}(?:\\s+(\\S+)(.*))?$`, 'i');
    const m = pattern.exec(trimmed);
    if (m) {
      return {
        flowName,
        subCmd: (m[1] ?? '').toLowerCase(),
        args: (m[2] ?? '').trim(),
      };
    }
  }
  return null;
}
