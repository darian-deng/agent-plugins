export const VALID_COMMANDS = ['start', 'approve', 'abort', 'resume', 'status', 'help'] as const;
export type FlowCommand = (typeof VALID_COMMANDS)[number];

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseFlowCommand(
  prompt: string,
  knownFlows: string[]
): { flowName: string; subCmd: string; args: string } | null {
  const trimmed = prompt.trim();
  for (const flowName of knownFlows) {
    // Flow name must appear at start, followed by whitespace or end-of-string
    if (!new RegExp(`^${escapeRegex(flowName)}(?:\\s|$)`, 'i').test(trimmed)) continue;

    const rest = trimmed.slice(flowName.length).trimStart();
    if (!rest) {
      return { flowName, subCmd: '', args: '' };
    }

    // Known commands: boundary after cmd is end-of-string, whitespace, or non-ASCII (CJK with no space)
    const validCmdsPattern = VALID_COMMANDS.map(escapeRegex).join('|');
    const knownMatch = new RegExp(
      `^(${validCmdsPattern})(?=$|\\s|[^\\x00-\\x7F])([\\s\\S]*)$`,
      'i',
    ).exec(rest);
    if (knownMatch) {
      return {
        flowName,
        subCmd: (knownMatch[1] ?? '').toLowerCase(),
        args: (knownMatch[2] ?? '').trimStart(),
      };
    }

    // Unknown command: first whitespace-delimited token
    const unknownMatch = /^(\S+)([\s\S]*)$/.exec(rest);
    return {
      flowName,
      subCmd: (unknownMatch?.[1] ?? '').toLowerCase(),
      args: (unknownMatch?.[2] ?? '').trim(),
    };
  }
  return null;
}
