# agent-plugins

A collection of Claude Code (and Cursor) plugins focused on giving AI agents the
same real-time feedback loops that human developers get in their IDEs.

## Available plugins

| Plugin | Description | Claude Code | Cursor |
|--------|-------------|:-----------:|:------:|
| [eslint-lsp](./plugins/eslint-lsp) | Real-time ESLint diagnostics via LSP + `@eslint/mcp` autofix | ✅ LSP + MCP | ✅ MCP |

## Installation (Claude Code)

```bash
# Add this marketplace
/plugin marketplace add darian-deng/agent-plugins

# Install a plugin
/plugin install eslint-lsp@darian-agent-plugins
```

## Philosophy

Human IDE experience is built on tight feedback loops — errors appear in
milliseconds, not after a manual lint run. These plugins bring the same
feedback loops to AI coding sessions.

## Contributing

PRs welcome. Each plugin lives in `plugins/<name>/` with its own README.

## License

MIT
