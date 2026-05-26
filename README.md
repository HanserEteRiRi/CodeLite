# CodeLite

> A lightweight terminal AI coding assistant built with TypeScript.

CodeLite implements a `model → tool → model` agent loop with a full-screen TUI. It brings Claude Code's core design patterns into a compact, readable codebase ideal for learning and extension.

## Architecture

```
User Input → TUI → Agent Loop → Anthropic API
                   ├─ Context Compression (5 strategies)
                   ├─ Tool Execution (13 built-in tools)
                   ├─ Permission Check (path / command / edit)
                   └─ Session Persistence (JSONL)
```

## Features

**Agent Loop** — Multi-step `model → tool → model` cycle within a single user turn, with progress tracking and retry logic.

**Full-Screen TUI** — Interactive terminal interface with virtual scrolling, mouse text selection, permission prompts, and real-time rendering.

**Context Compression** — Five strategies keep you within model limits:

| Strategy | Trigger | Description |
|----------|---------|-------------|
| Auto Compact | 85% utilization | LLM summarization of older messages |
| Snip Compact | `/snip` or auto | Deterministic middle-context removal |
| Context Collapse | `/collapse` or auto | Project summaries without deleting transcript |
| Micro Compact | Auto | Inline trimming of oversized tool outputs |
| Manual Compact | `/compact` | User-initiated LLM compression |

**Permission System** — Three-tier security with allowlist/denylist and interactive approval for path access, dangerous commands, and file edits.

**Session Management** — Append-only JSONL logs per working directory at `~/.code-lite/projects/`. Resume, fork, rename, and auto-cleanup after 30 days.

**MCP Support** — Model Context Protocol via stdio and Streamable HTTP. Auto protocol negotiation and tool wrapping (`mcp__server__tool`).

**Skills System** — Local `SKILL.md` workflows discovered from project and user directories.

**Built-in Tools** — `read-file` · `write-file` · `edit-file` · `patch-file` · `modify-file` · `grep-files` · `list-files` · `run-command` · `web-fetch` · `web-search` · `ask-user` · `load-skill`

## Quick Start

```bash
npm install
npm run dev        # Run with tsx
npm test           # 162 tests
npm run check      # TypeScript type-check
```

## Configuration

Create `~/.code-lite/settings.json`:

```json
{
  "model": "claude-sonnet-4-6",
  "env": {
    "ANTHROPIC_BASE_URL": "<your-api-endpoint>",
    "ANTHROPIC_AUTH_TOKEN": "<your-auth-token>"
  }
}
```

Or set environment variables: `CODE_LITE_MODEL`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`.

## Project Structure

```
src/
├── index.ts              Entry point
├── agent-loop.ts         Multi-step turn orchestrator
├── anthropic-adapter.ts  Anthropic Messages API adapter
├── tty-app.ts            Full-screen interactive TUI (~2200 lines)
├── tool.ts               ToolRegistry with Zod validation
├── config.ts             Runtime config from ~/.code-lite/settings.json
├── permissions.ts        PermissionManager (path/command/edit)
├── session.ts            JSONL session persistence
├── prompt.ts             System prompt builder
├── skills.ts             Skill discovery and loading
├── mcp.ts                MCP client (stdio + HTTP)
├── compact/              5 context compression strategies
├── tools/                13 built-in tool definitions
├── tui/                  Terminal UI rendering
└── utils/                Token estimation, errors, web utils
```

## License

MIT
