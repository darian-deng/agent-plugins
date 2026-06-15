import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Isolate the session→anchor registry (and any other CLAUDE_CONFIG_DIR-rooted
// state) into a throwaway temp dir so tests never read or pollute the real
// ~/.claude. Set before any module that reads CLAUDE_CONFIG_DIR is imported.
process.env['CLAUDE_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'ai-flow-claude-cfg-'));
