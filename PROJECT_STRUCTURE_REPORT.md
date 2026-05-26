# CodeLite -- Project Structure Report / Project Structure Report

---

## 1. Project Overview / Project Overview

| Item | Value |
|---|---|
| **Project Name / Project Name** | CodeLite |
| **Package Name / Package Name** | `code-lite` |
| **Version / Version** | 0.1.0 |
| **Language / Language** | TypeScript (strict mode) |
| **Runtime / Runtime** | Node.js + tsx (ESM) |
| **CLI Binary / CLI Binary** | `codelite` |
| **Config Directory / Config Directory** | `~/.code-lite` |
| **License / License** | MIT (Copyright 2026 Liu Mengxuan) |

CodeLite is a terminal-based AI coding assistant implementing a `model -> tool -> model` agent loop. It provides a full-screen interactive TUI (Terminal User Interface), supports 12 built-in tools, multiple context-compression strategies, MCP (Model Context Protocol) integration, and custom slash commands.

CodeLite 是一个基于终端的 AI 编码助手，实现了 `model -> tool -> model` 代理循环。它提供全屏交互式 TUI（终端用户界面），支持 12 个内置工具、多种上下文压缩策略、MCP（模型上下文协议）集成和自定义斜杠命令。

---

## 2. Current Directory Tree / Current Directory Tree

```
MiniCode/
├── .mini-code/                          # Project-local skills / Project-local skills
│   └── skills/
│       └── 黛冬优子蒸馏skill/
│           ├── references/
│           │   └── research/
│           │       ├── 01-writings.md
│           │       ├── 02-conversations.md
│           │       ├── 03-expression-dna.md
│           │       ├── 04-external-views.md
│           │       ├── 05-decisions.md
│           │       └── 06-timeline.md
│           └── scripts/
│
├── bin/
│   └── codelite                         # CLI entry point (bash script) / CLI entry point (bash script)
│
├── src/                                 # Source code / Source code
│   ├── compact/                         # Context compression strategies / Context compression strategies
│   ├── tools/                           # Built-in tool definitions / Built-in tool definitions
│   ├── tui/                             # Terminal UI rendering / Terminal UI rendering
│   └── utils/                           # Utility modules / Utility modules
│
├── test/                                # Test files / Test files
│
├── ARCHITECTURE.md                      # Architecture documentation (English) / Architecture documentation (English)
├── ARCHITECTURE_ZH.md                   # Architecture documentation (Chinese) / Architecture documentation (Chinese)
├── CLAUDE_CODE_PATTERNS.md              # Claude Code patterns (English) / Claude Code patterns (English)
├── CLAUDE_CODE_PATTERNS_ZH.md           # Claude Code patterns (Chinese) / Claude Code patterns (Chinese)
├── CLAUDE.md                            # Claude workspace configuration / Claude workspace configuration
├── eslint.config.js                     # ESLint flat config / ESLint flat config
├── LICENSE                              # MIT License / MIT License
├── package.json                         # Package manifest / Package manifest
├── ROADMAP.md                           # Development roadmap (English) / Development roadmap (English)
├── ROADMAP_ZH.md                        # Development roadmap (Chinese) / Development roadmap (Chinese)
└── tsconfig.json                        # TypeScript configuration / TypeScript configuration
```

---

## 3. Source Code File Map / Source Code File Map

### 3.1 Root Source Files (`src/`)

| File / File | Role / Role |
|---|---|
| `src/index.ts` | Entry point: CLI argument parsing, config loading, session management, TTY app launch / Entry point: CLI 参数解析、配置加载、session management、启动 TTY 应用 |
| `src/types.ts` | Core type definitions: `ChatMessage` (9-role discriminated union), `ModelAdapter`, `AgentStep`, `ToolCall`, `CompressionResult` / Core type definitions: `ChatMessage` (9-role discriminated union), `ModelAdapter`, `AgentStep`, `ToolCall`, `CompressionResult` |
| `src/config.ts` | Runtime config loading: `~/.code-lite/settings.json` cascade, env vars, MCP server definitions, `CODE_LITE_HOME` / Runtime config loading: `~/.code-lite/settings.json` cascade, env vars, MCP server definitions, `CODE_LITE_HOME` |
| `src/tty-app.ts` | Full-screen interactive TUI (~2200 lines): keyboard/mouse input, transcript rendering, session lifecycle, permission prompts, tool execution shortcuts / Full-screen interactive TUI (~2200 lines): keyboard/mouse input, transcript rendering, session lifecycle, permission prompts, tool execution shortcuts |
| `src/agent-loop.ts` | Multi-step turn orchestrator: context pressure check, model call, tool execution, iteration / Multi-step turn orchestrator: context pressure check, model call, tool execution, iteration |
| `src/anthropic-adapter.ts` | Anthropic Messages API adapter: converts `ChatMessage[]` to API format, handles thinking blocks, tool use/result, retry with exponential backoff / Anthropic Messages API adapter: converts `ChatMessage[]` to API format, handles thinking blocks, tool use/result, retry with exponential backoff |
| `src/mock-model.ts` | Offline mock model for testing (`CODE_LITE_MODEL_MODE=mock`) / Offline mock model for testing (`CODE_LITE_MODEL_MODE=mock`) |
| `src/tool.ts` | `ToolRegistry` class: register, list, lookup, execute tools with Zod validation / `ToolRegistry` class: register, list, lookup, execute tools with Zod validation |
| `src/permissions.ts` | `PermissionManager`: three permission kinds (path, command, edit) with allow/deny decisions / `PermissionManager`: three permission kinds (path, command, edit) with allow/deny decisions |
| `src/session.ts` | JSONL session persistence at `~/.code-lite/projects/<dir>/<id>.jsonl`: save, load, resume, fork, rename, expire / JSONL session persistence at `~/.code-lite/projects/<dir>/<id>.jsonl`: save, load, resume, fork, rename, expire |
| `src/prompt.ts` | System prompt builder: reads CLAUDE.md, skills, MCP info / System prompt builder: reads CLAUDE.md, skills, MCP info |
| `src/mcp.ts` | MCP client: stdio (content-length framing) and Streamable HTTP, auto protocol negotiation, tool wrapping with `mcp__` prefix / MCP client: stdio (content-length framing) and Streamable HTTP, auto protocol negotiation, tool wrapping with `mcp__` prefix |
| `src/mcp-status.ts` | MCP server status display / MCP server status display |
| `src/skills.ts` | Skill discovery from 4 locations, loading SKILL.md, install/remove / Skill discovery from 4 locations, loading SKILL.md, install/remove |
| `src/history.ts` | Command history persistence at `~/.code-lite/history.jsonl` / Command history persistence at `~/.code-lite/history.jsonl` |
| `src/workspace.ts` | Workspace/project directory management / Workspace/project directory management |
| `src/cli-commands.ts` | Slash command handling (e.g., `/compact`, `/snip`, `/resume`) / Slash command handling (e.g., `/compact`, `/snip`, `/resume`) |
| `src/manage-cli.ts` | Management CLI commands (edit config, manage MCP, etc.) / Management CLI commands (edit config, manage MCP, etc.) |
| `src/install.ts` | Local installation utilities / Local installation utilities |
| `src/file-review.ts` | File diff/review rendering / File diff/review rendering |
| `src/background-tasks.ts` | Background task tracking (e.g., background bash commands) / Background task tracking (e.g., background bash commands) |
| `src/local-tool-shortcuts.ts` | Tool shortcut key bindings / Tool shortcut key bindings |
| `src/ui.ts` | General UI rendering helpers (banners, panels) / General UI rendering helpers (banners, panels) |

### 3.2 Compact Module (`src/compact/`)

Context compression strategies -- protecting against context window overflow / Context compression strategies -- protecting against context window overflow

| File / File | Role / Role |
|---|---|
| `src/compact/constants.ts` | Threshold values for all compact strategies / Threshold values for all compact strategies |
| `src/compact/auto-compact.ts` | Automatic compact trigger when context utilization > 85%. Disables after 3 consecutive failures / Automatic compact trigger when context utilization > 85%. Disables after 3 consecutive failures |
| `src/compact/compact.ts` | LLM-based summarization: model summarizes older messages, replaces them with `context_summary` / LLM-based summarization: model summarizes older messages, replaces them with `context_summary` |
| `src/compact/snipCompact.ts` | Deterministic middle-context removal protecting file edits/errors/recent messages. No model call. Triggered by `/snip` or auto-pressure / Deterministic middle-context removal protecting file edits/errors/recent messages. No model call. Triggered by `/snip` or auto-pressure |
| `src/compact/context-collapse.ts` | Projects summarized spans into model-visible context without deleting original transcript. Persistent across sessions / Projects summarized spans into model-visible context without deleting original transcript. Persistent across sessions |
| `src/compact/microcompact.ts` | Lightweight inline trimming of oversized tool outputs / Lightweight inline trimming of oversized tool outputs |
| `src/compact/manual-compact.ts` | Manually triggered compact via slash command / Manually triggered compact via slash command |
| `src/compact/prompt.ts` | Compact-specific prompts for LLM summarization / Compact-specific prompts for LLM summarization |

### 3.3 Tools Module (`src/tools/`)

12 built-in tool definitions. Each tool exports a `ToolDefinition<TInput>` with `name`, `description`, `inputSchema` (JSON Schema), `schema` (Zod validation), and `run()`.

12 个内置工具定义。每个工具导出 `ToolDefinition<TInput>`，包含 `name`、`description`、`inputSchema`（JSON Schema）、`schema`（Zod 验证）和 `run()`。

| File / File | Tool Name / Tool Name | Description / Description |
|---|---|---|
| `src/tools/index.ts` | -- | ToolRegistry factory: registers all built-in tools, discovers skills, hydrates MCP tools / ToolRegistry factory: registers all built-in tools, discovers skills, hydrates MCP tools |
| `src/tools/read-file.ts` | `read-file` | Read file contents with line range support / Read file contents with line range support |
| `src/tools/write-file.ts` | `write-file` | Create or overwrite files / Create or overwrite files |
| `src/tools/edit-file.ts` | `edit-file` | String-precise file editing / String-precise file editing |
| `src/tools/modify-file.ts` | `modify-file` | Modify files by adding/replacing sections / Modify files by adding/replacing sections |
| `src/tools/patch-file.ts` | `patch-file` | Apply unified diff patches to files / Apply unified diff patches to files |
| `src/tools/grep-files.ts` | `grep-files` | Search file contents with regex / Search file contents with regex |
| `src/tools/list-files.ts` | `list-files` | List files using glob patterns / List files using glob patterns |
| `src/tools/run-command.ts` | `run-command` | Execute shell commands (with background task support) / Execute shell commands (with background task support) |
| `src/tools/web-fetch.ts` | `web-fetch` | Fetch and process web page content / Fetch and process web page content |
| `src/tools/web-search.ts` | `web-search` | Perform web searches / Perform web searches |
| `src/tools/ask-user.ts` | `ask-user` | Prompt the user for input during agent execution / Prompt the user for input during agent execution |
| `src/tools/load-skill.ts` | `load-skill` | Load user-defined skills / Load user-defined skills |

### 3.4 TUI Module (`src/tui/`)

Terminal UI rendering components using ANSI escape sequences / Terminal UI rendering components using ANSI escape sequences

| File / File | Role / Role |
|---|---|
| `src/tui/index.ts` | Barrel export for all TUI components / Barrel export for all TUI components |
| `src/tui/types.ts` | TUI-specific type definitions (`TranscriptEntry`, etc.) / TUI-specific type definitions (`TranscriptEntry`, etc.) |
| `src/tui/chrome.ts` | Panel rendering: banners, context badges, footer bars, permission prompts, slash menus, status lines, tool panels / Panel rendering: banners, context badges, footer bars, permission prompts, slash menus, status lines, tool panels |
| `src/tui/transcript.ts` | Transcript rendering with virtual scrolling and text selection / Transcript rendering with virtual scrolling and text selection |
| `src/tui/screen.ts` | Alternate screen buffer management, cursor visibility / Alternate screen buffer management, cursor visibility |
| `src/tui/input-parser.ts` | Terminal input byte sequence parsing (keyboard, mouse) / Terminal input byte sequence parsing (keyboard, mouse) |
| `src/tui/input.ts` | Input prompt rendering / Input prompt rendering |
| `src/tui/markdown.ts` | Markdown-to-ANSI rendering / Markdown-to-ANSI rendering |

### 3.5 Utils Module (`src/utils/`)

| File / File | Role / Role |
|---|---|
| `src/utils/context.ts` | Context management utilities / Context management utilities |
| `src/utils/errors.ts` | Error code detection, ENOENT handling / Error code detection, ENOENT handling |
| `src/utils/model-context.ts` | Model context window size lookup / Model context window size lookup |
| `src/utils/token-estimator.ts` | Token usage estimation for context pressure monitoring / Token usage estimation for context pressure monitoring |
| `src/utils/tool-result-storage.ts` | Offloading large tool results to disk to save memory / Offloading large tool results to disk to save memory |
| `src/utils/web.ts` | Web fetch/request utilities / Web fetch/request utilities |

### 3.6 Test Files (`test/`)

18 test files using Node.js built-in test runner (`node:test` + `node:assert`) / 18 个测试文件使用 Node.js built-in test runner (`node:test` + `node:assert`)

| File / File | Coverage / Coverage |
|---|---|
| `test/run-tests.mjs` | Test runner script: spawns `node --import tsx --test` / Test runner script: spawns `node --import tsx --test` |
| `test/anthropic-thinking-roundtrip.test.ts` | Anthropic API thinking block round-trip conversion / Anthropic API thinking block round-trip conversion |
| `test/auto-compact.test.ts` | Auto-compact trigger logic / Auto-compact trigger logic |
| `test/compact.test.ts` | LLM summarization compact / LLM summarization compact |
| `test/context-badge.test.ts` | Context utilization badge rendering / Context utilization badge rendering |
| `test/context-collapse.test.ts` | Context collapse projection / Context collapse projection |
| `test/input-parser.test.ts` | Terminal input sequence parsing / Terminal input sequence parsing |
| `test/local-tool-shortcuts.test.ts` | Tool shortcut key bindings / Tool shortcut key bindings |
| `test/microcompact.test.ts` | Microcompact inline trimming / Microcompact inline trimming |
| `test/model-context.test.ts` | Model context window configuration / Model context window configuration |
| `test/mouse-release-selection.test.ts` | Mouse selection release behavior / Mouse selection release behavior |
| `test/provider-usage-ingestion.test.ts` | Provider usage metadata ingestion / Provider usage metadata ingestion |
| `test/session.test.ts` | Session persistence (JSONL) / Session persistence (JSONL) |
| `test/snip-compact.test.ts` | Snip compact middle removal / Snip compact middle removal |
| `test/token-estimator.test.ts` | Token count estimation / Token count estimation |
| `test/tool-result-storage.test.ts` | Tool result disk offloading / Tool result disk offloading |
| `test/transcript-cjk-selection.test.ts` | CJK character text selection / CJK character text selection |
| `test/transcript-wrapping.test.ts` | Transcript text wrapping / Transcript text wrapping |
| `test/windows-clipboard-encoding.test.ts` | Windows clipboard encoding / Windows clipboard encoding |

---

## 4. Core Module Descriptions / Core Module Descriptions

### 4.1 Agent Loop / Agent Loop

The core execution loop in `src/agent-loop.ts` (`runAgentTurn()`) implements the multi-step `model -> tool -> model` cycle:

核心执行循环在 `src/agent-loop.ts` (`runAgentTurn()`) 中实现多步 `model -> tool -> model` 循环：

1. **Context Check / Context Check** -- Evaluate if context utilization exceeds thresholds, apply appropriate compression
2. **Model Call / Model Call** -- Send messages to the model adapter (Anthropic API or mock)
3. **Tool Execution / Tool Execution** -- Execute any tool calls returned by the model, with permission checking
4. **Iterate / Iterate** -- Feed tool results back to the model, repeat until final response

### 4.2 Model Adapter / Model Adapter

`src/anthropic-adapter.ts` implements the `ModelAdapter` interface from `src/types.ts`:
- Converts internal `ChatMessage[]` to Anthropic Messages API format
- Handles thinking blocks, tool use blocks, and tool result blocks
- Retry with exponential backoff on API errors
- `src/mock-model.ts` provides an offline mock adapter for testing via `CODE_LITE_MODEL_MODE=mock`

`src/anthropic-adapter.ts` 实现 `src/types.ts` 中的 `ModelAdapter` 接口：
- 将内部 `ChatMessage[]` 转换为 Anthropic Messages API 格式
- 处理 thinking blocks、tool use blocks 和 tool result blocks
- API 错误时使用指数退避重试
- `src/mock-model.ts` 提供离线 mock 适配器用于测试，通过 `CODE_LITE_MODEL_MODE=mock` 激活

### 4.3 Context Compression (5 Strategies) / Context Compression (5 Strategies)

The system monitors context window utilization and applies escalating compression strategies / The system monitors context window utilization and applies escalating compression strategies：

| Strategy / Strategy | Trigger / Trigger | Mechanism / Mechanism |
|---|---|---|
| **Microcompact** | Utilization > 50% | Inline trimming of oversized tool outputs / Inline trimming of oversized tool outputs |
| **Context Collapse** | Utilization > 75% | LLM projects span summaries into context without deletion / LLM projects span summaries into context without deletion |
| **Snip** | Utilization > 70% or `/snip` | Deterministic middle-context removal (no model call) / Deterministic middle-context removal (no model call) |
| **Auto-Compact** | Utilization > 85% | LLM-powered full summarization via `compactConversation()` / LLM-powered full summarization via `compactConversation()` |
| **Manual Compact** | User slash command | User-invoked LLM summarization / User-invoked LLM summarization |

Key thresholds from `src/compact/constants.ts`:
- `AUTOCOMPACT_UTILIZATION`: 0.85
- `SNIP_COMPACT_THRESHOLD`: 0.70
- `CONTEXT_COLLAPSE_UTILIZATION`: 0.75
- `MICROCOMPACT_UTILIZATION`: 0.50
- `MAX_AUTOCOMPACT_FAILURES`: 3

### 4.4 Permission System / Permission System

`src/permissions.ts` implements a three-kind permission system / `src/permissions.ts` 实现了三种权限类型：

| Kind / Type | Scope / Scope | Decisions / Decisions |
|---|---|---|
| `path` | Read/write outside cwd / Read/write outside cwd | `allow_once`, `allow_always`, `allow_turn`, `allow_all_turn`, `deny_once`, `deny_always`, `deny_with_feedback` |
| `command` | Dangerous shell operations / Dangerous shell operations | Same / Same |
| `edit` | File modifications / File modifications | Same / Same |

### 4.5 MCP Integration / MCP Integration

`src/mcp.ts` implements the Model Context Protocol client / `src/mcp.ts` 实现 Model Context Protocol 客户端：
- **Transport / Transport**: stdio (content-length framing) and Streamable HTTP
- **Protocol / Protocol**: Auto negotiation, JSON-RPC 2.0
- **Tool Namespace / Tool Namespace**: `mcp__` prefix for all MCP-provided tools
- **Configuration / Configuration**: MCP servers defined in `~/.code-lite/settings.json` under `mcpServers`
- **Status Display / Status Display**: `src/mcp-status.ts` renders connection status for each server

### 4.6 Session Persistence / Session Persistence

`src/session.ts` uses append-only JSONL format at `~/.code-lite/projects/<dir>/<id>.jsonl` / `src/session.ts` 使用 append-only JSONL 格式存储在 `~/.code-lite/projects/<dir>/<id>.jsonl`：
- Each line is a JSON event: `system`, `user`, `assistant`, `thinking`, `progress`, `tool_call`, `tool_result`, `summary`, `compact_boundary`, `snip_boundary`, `context_collapse`, `rename`
- Supports: save, load, resume, fork, rename, list, and expiry cleanup
- Context collapse spans persist across sessions

### 4.7 TUI System / TUI System

The TUI in `src/tty-app.ts` (~2200 lines) provides:
- Full alternate screen mode (`src/tui/screen.ts`)
- Keyboard and mouse input parsing (`src/tui/input-parser.ts`)
- Virtual scrolling transcript with text selection (`src/tui/transcript.ts`)
- Markdown rendering to ANSI (`src/tui/markdown.ts`)
- Panel and chrome rendering (`src/tui/chrome.ts`)
- Permission prompt dialogs
- Slash command completion menu

---

## 5. Architecture Flow Diagram / Architecture Flow Diagram

```
                            SUB-PROJECT config
                            ┌── ~/.code-lite/settings.json
                            │   ~/.code-lite/history.jsonl
                            │   ~/.code-lite/projects/
                            │   CODE_LITE_HOME env var
                            │
                            │
  ┌─────────────────────────▼──────────────────────────────────┐
  │  Entry: bin/codelite ──> tsx src/index.ts                   │
  │                                                            │
  │  1. Parse CLI args (cwd, --resume, --fork, slash commands)  │
  │  2. Load config (config.ts) ── .code-lite/settings.json     │
  │  3. Build system prompt (prompt.ts) ── CLAUDE.md, skills   │
  │  4. Create model adapter (anthropic-adapter.ts / mock)      │
  │  5. Create ToolRegistry (tools/index.ts) ── 12 built-in     │
  │  6. Hydrate MCP tools (mcp.ts)                              │
  │  7. Launch TTY app (tty-app.ts)                             │
  └─────────────────────────┬──────────────────────────────────┘
                             │
        ┌────────────────────▼────────────────────────┐
        │          tty-app.ts (TUI Loop)               │
        │                                              │
        │  Input ──> parseInputChunk()                 │
        │    │                                         │
        │    ├── Normal text ──> runAgentTurn()        │
        │    ├── Slash command ──> cli-commands.ts     │
        │    └── Tool shortcut ──> direct tool exec    │
        │                                              │
        │  Output <── renderTranscript()               │
        │           <── renderChrome()                 │
        └────────────────────┬────────────────────────┘
                             │
        ┌────────────────────▼────────────────────────┐
        │       agent-loop.ts (Agent Turn)             │
        │                                              │
        │  LOOP:                                       │
        │    1. ContextPressureCheck ──> compact/*     │
        │       ├── microcompact (50%)                 │
        │       ├── context-collapse (75%)             │
        │       ├── snipCompact (70%)                  │
        │       └── auto-compact (85%)                 │
        │    2. ModelAdapter.next(messages)            │
        │       ├── AnthropicModelAdapter              │
        │       └── MockModelAdapter (testing)         │
        │    3. ToolRegistry.execute(toolCalls)        │
        │       ├── Built-in tools (12)                │
        │       └── MCP tools (mcp__*)                 │
        │    4. IF has tool_calls → GOTO 1             │
        │       ELSE → return final response           │
        └────────────────────┬────────────────────────┘
                             │
        ┌────────────────────▼────────────────────────┐
        │       session.ts (Persistence)               │
        │                                              │
        │  Append-only JSONL log                       │
        │  ~/.code-lite/projects/<dir>/<id>.jsonl      │
        │                                              │
        │  Events: system|user|assistant|thinking|     │
        │          progress|tool_call|tool_result|     │
        │          summary|snip_boundary|collapse      │
        └──────────────────────────────────────────────┘
```

---

## 6. Configuration & Scripts / Configuration & Scripts

### 6.1 package.json Scripts

| Command | Function / Function |
|---|---|
| `npm run dev` | Start with tsx (development) / 使用 tsx 启动（开发模式） |
| `npm run check` | TypeScript type-check (`tsc --noEmit`) / TypeScript 类型检查 |
| `npm run lint` | ESLint on `src/` and `test/` / ESLint 检查 `src/` 和 `test/` |
| `npm test` | Run all tests (`node test/run-tests.mjs`) / 运行所有测试 |
| `npm run install-local` | Local installation (`tsx src/install.ts`) / 本地安装 |

### 6.2 TypeScript Configuration (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

### 6.3 ESLint Configuration (`eslint.config.js`)

- Flat config format with `@eslint/js` recommended + `typescript-eslint` recommended
- Ignores: `dist/**`, `node_modules/**`, `coverage/**`, `docs/**`
- Files: `src/**/*.ts`, `test/**/*.ts`
- Key rules: `no-unused-vars` off (handled by TypeScript), `@typescript-eslint/no-unused-vars` warns on non-`_` prefixed variables

### 6.4 Dependencies

| Package | Category | Purpose |
|---|---|---|
| `diff` (^8.0.4) | runtime | Text diffing for file editing tools |
| `zod` (^4.1.5) | runtime | Runtime schema validation for tools and config |
| `@eslint/js` (9.39.1) | dev | ESLint base config |
| `@types/node` (^24.6.0) | dev | Node.js type definitions |
| `eslint` (9.39.1) | dev | Linting |
| `tsx` (^4.20.6) | dev | TypeScript executor (dev runtime) |
| `typescript` (^5.9.2) | dev | TypeScript compiler |
| `typescript-eslint` (8.46.4) | dev | TypeScript ESLint integration |

### 6.5 Naming Conventions / Naming Conventions

| Context / Context | Convention / Convention |
|---|---|
| Project display name / Project display name | **CodeLite** |
| Package name / Package name | **code-lite** |
| Binary/CLI name / Binary/CLI name | **codelite** |
| Config directory / Config directory | **~/.code-lite** |
| Env var prefix / Env var prefix | **CODE_LITE** (e.g., `CODE_LITE_HOME`, `CODE_LITE_MODEL_MODE`) |
| GitHub repo / GitHub repo | (deleted) |
| Docs / Docs | (deleted) |

### 6.6 ChatMessage Roles (from `src/types.ts`)

| Role | Description / Description |
|---|---|
| `system` | System prompt message / System prompt message |
| `user` | User input message / User input message |
| `assistant` | Model text response / Model text response |
| `assistant_thinking` | Model thinking blocks (Anthropic extended thinking) / Model thinking blocks (Anthropic extended thinking) |
| `assistant_progress` | Streaming progress before final response / Streaming progress before final response |
| `assistant_tool_call` | Tool use request from the model / Tool use request from the model |
| `tool_result` | Tool execution result (ok or error) / Tool execution result (ok or error) |
| `context_summary` | Summarized older messages from LLM compact / Summarized older messages from LLM compact |
| `snip_boundary` | Boundary marker from `/snip` middle removal / Boundary marker from `/snip` middle removal |

---

*Report generated 2026-05-26 for CodeLite v0.1.0*
*Report generated 2026-05-26 for CodeLite v0.1.0*
