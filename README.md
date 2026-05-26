# CodeLite

A lightweight, terminal-based AI coding assistant. Implements a `model -> tool -> model` agent loop with a full-screen TUI, permission management, session persistence, context compression, MCP support, and a local skills system.

## Features

- **Agent Loop** — Multi-step tool execution cycle (model → tool → model) within a single user turn
- **Full-Screen TUI** — Interactive terminal UI with virtual scrolling, text selection, and real-time rendering
- **Context Compression** — Five strategies (LLM summarization, snip, context collapse, micro-compact, auto-compact) to stay within model context limits
- **Permission System** — Three-tier security model (path, command, edit) with allowlist/denylist and interactive approval
- **Session Persistence** — Append-only JSONL session logs with resume, fork, rename, and expiry management
- **MCP Support** — Model Context Protocol integration via stdio and Streamable HTTP transport
- **Skills System** — Local SKILL.md workflows discovered from project and user directories
- **13 Built-in Tools** — read, write, edit, patch, grep, list-files, run-command, web-fetch, web-search, ask-user, load-skill, modify-file, patch-file

## Quick Start

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run tests
npm test

# Type check
npm run check
```

## Configuration

CodeLite reads configuration from `~/.code-lite/settings.json`, falling back to `~/.claude/settings.json` and environment variables:

```json
{
  "model": "claude-sonnet-4-6",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_AUTH_TOKEN": "your-token"
  }
}
```

## License

MIT
