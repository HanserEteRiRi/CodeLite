# CLAUDE.md

## Build / Test / Lint

```bash
npm run dev            # Run with tsx (development)
npm run check          # TypeScript type-check (tsc --noEmit)
npm run lint           # ESLint on src/ and test/
npm test               # Run all tests (node --import tsx --test)
```

- Entry point: `src/index.ts`
- Runtime: Node.js with `tsx`, ESM (`"type": "module"`)
- No build step required for development; `tsx` runs TypeScript directly.

## Architecture

CodeLite is a terminal coding assistant implementing a `model → tool → model` agent loop.

### Core Loop Flow

```
src/index.ts (entry, CLI arg parsing)
  → src/config.ts (load runtime config: ~/.code-lite/settings.json, env, MCP)
  → src/tty-app.ts (~2200 lines, full-screen interactive TUI)
    → src/agent-loop.ts (multi-step turn orchestrator)
      ├─ src/compact/ (5 context-compression strategies)
      ├─ ModelAdapter.next() → Anthropic API or Mock
      ├─ ToolRegistry.execute() → permission-checked tool calls
      └─ src/session.ts (append-only JSONL persistence)
```

### Key Modules

| Directory/File | Purpose |
|---|---|
| `src/tty-app.ts` | Full interactive TTY app — keyboard/mouse input, transcript rendering, session lifecycle, permission prompts, tool execution shortcuts. |
| `src/agent-loop.ts` | `runAgentTurn()` — the multi-step loop: check context pressure, call model, execute tools, iterate. |
| `src/anthropic-adapter.ts` | Converts `ChatMessage[]` to Anthropic Messages API format. Handles thinking blocks, tool use/result, retry with exponential backoff. |
| `src/mock-model.ts` | Offline mock model for testing (`CODE_LITE_MODEL_MODE=mock`). |
| `src/tool.ts` | `ToolRegistry` class — register, list, lookup, execute tools with Zod validation. |
| `src/tools/` | 13 built-in tool definitions (`read-file`, `write-file`, `edit-file`, `grep-files`, `list-files`, `run-command`, `web-fetch`, `web-search`, `ask-user`, `modify-file`, `patch-file`, `load-skill`). |
| `src/types.ts` | Core types: `ChatMessage` (8-role discriminated union), `ModelAdapter`, `AgentStep`, `ToolCall`, `CompressionResult`. |
| `src/permissions.ts` | `PermissionManager` — three permission kinds: path (read/write outside cwd), command (dangerous shell ops), edit (file modifications). |
| `src/session.ts` | JSONL session log at `~/.code-lite/projects/<dir>/<id>.jsonl`. Supports save/load/resume/fork/rename/expiry. |
| `src/config.ts` | Cascade: `~/.code-lite/settings.json` → `~/.claude/settings.json` → env vars. Manages MCP server definitions and model selection. |
| `src/prompt.ts` | System prompt builder — reads CLAUDE.md, skills, MCP info. |
| `src/mcp.ts` | MCP client: stdio (content-length framing) and Streamable HTTP. Auto protocol negotiation, tool wrapping with `mcp__` prefix. |
| `src/skills.ts` | Skill discovery from 4 locations, loading SKILL.md, install/remove. |
| `src/tui/` | TUI rendering: `chrome.ts` (panels/banners), `transcript.ts` (virtual scroll, text selection), `input-parser.ts` (terminal byte sequences), `markdown.ts` (markdown→ANSI), `screen.ts` (alternate screen, cursor). |
| `src/compact/` | Context compression: auto-compact (85% utilization trigger), LLM summarization, `/snip` (deterministic middle removal), context collapse (projection without deletion), micro-compact (inline trimming). |
| `src/utils/` | Token estimation, tool result disk offloading, web fetch, error code detection, model context window lookup. |

### Context Compression (5 strategies)

1. **Auto-compact** (`auto-compact.ts`) — triggers `compactConversation()` when context utilization > 85%. Disables after 3 consecutive failures.
2. **LLM compact** (`compact.ts`) — model summarizes older messages, replaces them with `context_summary`.
3. **Snip** (`snipCompact.ts`) — deterministic middle-context removal protecting file edits/errors/recent messages. No model call. Triggered by `/snip` or auto-pressure.
4. **Context collapse** (`context-collapse.ts`) — projects summarized spans into model-visible context **without deleting original transcript**. Persistent across sessions.
5. **Micro-compact** (`microcompact.ts`) — lightweight inline trimming of oversized tool outputs.

### ChatMessage Roles (in `src/types.ts`)

`system` | `user` | `assistant` | `assistant_thinking` | `assistant_progress` | `assistant_tool_call` | `tool_result` | `context_summary` | `snip_boundary`

## Coding Conventions

- **Node builtins**: Import with `node:` prefix (`import crypto from 'node:crypto'`).
- **Extension**: Always use `.js` extension for local imports (ESM resolution).
- **Type imports**: Use `import type { ... }` for type-only imports.
- **Const by default**: Prefer `const`; use `let` only when reassignment is needed.
- **Async functions**: Use `async function name(): Promise<ReturnType>` style.
- **Error handling**: `error instanceof Error ? error.message : String(error)`. Empty catch blocks get a short comment (`// Ignore double-close during EOF teardown.`).
- **Comments**: Only for non-obvious WHY. No JSDoc on functions, no "what" comments that echo the code.
- **Tool definitions**: Each tool exports a `ToolDefinition<TInput>` with `name`, `description`, `inputSchema`, `schema` (Zod), and async `run()`.
- **Validation**: Use `zod` (v4) for runtime schema validation in tools and config.
- **Diffing**: Use the `diff` package for text comparison in file editing tools.
- **Strict TypeScript**: `strict: true` in tsconfig. Don't weaken types with `any` unless unavoidable (`@typescript-eslint/no-explicit-any` is off but use sparingly).
- **Unused vars**: Pattern `_` prefix signals intentional unused (e.g., `_error`, `_request`).

## Testing

- Files in `test/` match `*.test.ts` pattern.
- Runner: `node test/run-tests.mjs` spawns `node --import tsx --test`.
- Use Node's built-in test runner (`node:test` + `node:assert`).
- 19 test files covering: session persistence, token estimation, compact strategies, transcript rendering, input parsing, CJK selection, clipboard encoding.
