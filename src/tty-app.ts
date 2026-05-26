import crypto from 'node:crypto'
import process from 'node:process'
import { listBackgroundTasks } from './background-tasks.js'
import { runAgentTurn } from './agent-loop.js'
import {
  SLASH_COMMANDS,
  findMatchingSlashCommands,
  tryHandleLocalCommand,
} from './cli-commands.js'
import { loadHistoryEntries, saveHistoryEntries } from './history.js'
import { parseLocalToolShortcut } from './local-tool-shortcuts.js'
import { summarizeMcpServers } from './mcp-status.js'
import {
  PermissionManager,
  PermissionPromptResult,
  PermissionRequest,
} from './permissions.js'
import { buildSystemPrompt } from './prompt.js'
import {
  saveSession,
  loadSession,
  clearSession,
  listSessions,
  renameSession,
  appendCompactBoundary,
  appendSnipBoundary,
  appendContextCollapseSpan,
  loadTranscript,
  loadContextCollapseState,
  forkSession,
  cleanupExpiredSessions,
  listAllProjects,
} from './session.js'
import type { SessionMeta, ProjectMeta } from './session.js'
import { spawn } from 'node:child_process'
import { parseInputChunk, type ParsedInputEvent } from './tui/input-parser.js'
import {
  clearScreen,
  enterAlternateScreen,
  exitAlternateScreen,
  getPermissionPromptMaxScrollOffset,
  hideCursor,
  renderBanner,
  renderFooterBar,
  renderInputPrompt,
  renderPanel,
  renderPermissionPrompt,
  renderSlashMenu,
  renderStatusLine,
  renderToolPanel,
  renderTranscript,
  getTranscriptMaxScrollOffset,
  showCursor,
  extractSelectedText,
  renderTranscriptLines,
  getTranscriptWindowSize,
  type TranscriptEntry,
  type TranscriptSelection,
} from './ui.js'
import type { RuntimeConfig } from './config.js'
import type { ToolRegistry } from './tool.js'
import type { ChatMessage, CompressionResult, ModelAdapter } from './types.js'
import type { ContextStats } from './utils/token-estimator.js'
import { computeContextStats } from './utils/token-estimator.js'
import { manualCompact } from './compact/manual-compact.js'
import { snipCompactConversation } from './compact/snipCompact.js'
import {
  applyContextCollapseIfNeeded,
  createContextCollapseState,
  type ContextCollapseResult,
  type ContextCollapseState,
} from './compact/context-collapse.js'
import {
  createContentReplacementState,
  type ContentReplacementState,
} from './utils/tool-result-storage.js'

type TtyAppArgs = {
  runtime: RuntimeConfig | null
  tools: ToolRegistry
  model: ModelAdapter
  messages: ChatMessage[]
  cwd: string
  permissions: PermissionManager
  contentReplacementState?: ContentReplacementState
  contextCollapseState?: ContextCollapseState
  sessionId: string
  alreadySavedCount: number
  resumeTarget?: string | 'picker'
}

type PendingApproval = {
  request: PermissionRequest
  resolve: (result: PermissionPromptResult) => void
  detailsExpanded: boolean
  detailsScrollOffset: number
  selectedChoiceIndex: number
  feedbackMode: boolean
  feedbackInput: string
}

type SessionPicker = {
  sessions: SessionMeta[]
  selectedIndex: number
  resolve: (sessionId: string | null) => void
  deleteConfirmIndex: number | null
  allProjects: boolean
  projects: ProjectMeta[]
  projectSelectedIndex: number
}

type ScreenState = {
  input: string
  cursorOffset: number
  transcript: TranscriptEntry[]
  transcriptScrollOffset: number
  selectedSlashIndex: number
  status: string | null
  activeTool: string | null
  recentTools: Array<{ name: string; status: 'success' | 'error' }>
  history: string[]
  historyIndex: number
  historyDraft: string
  nextEntryId: number
  pendingApproval: PendingApproval | null
  sessionPicker: SessionPicker | null
  isBusy: boolean
  contextStats: ContextStats | null
  compressionStatus: string | null
  selection: TranscriptSelection | null
  mouseDown: { x: number; y: number } | null
  transcriptBodyStartY: number
  transcriptBodyLines: number
}

type TranscriptEntryDraft =
  | Omit<Extract<TranscriptEntry, { kind: 'user' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'assistant' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'progress' }>, 'id'>
  | Omit<Extract<TranscriptEntry, { kind: 'tool' }>, 'id'>

// 将时间戳格式化为相对时间字符串（如 "3m ago"）
// Format a timestamp into a relative time string (e.g. "3m ago")
function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// 鼠标释放后保留文本选区（用于持续高亮复制文本）
// Keep the text selection highlight after mouse release (for persistent copied text)
export function keepSelectionAfterMouseRelease(
  selection: TranscriptSelection | null,
): TranscriptSelection | null {
  return selection
}

// 收集会话统计数据（转录事件数、消息数、MCP 状态等）
// Gather session statistics (transcript count, message count, MCP status, etc.)
function getSessionStats(args: TtyAppArgs, state: ScreenState) {
  const mcpStatus = summarizeMcpServers(args.tools.getMcpServers())
  return {
    transcriptCount: state.transcript.length,
    messageCount: args.messages.length,
    skillCount: args.tools.getSkills().length,
    mcpTotalCount: mcpStatus.total,
    mcpConnectedCount: mcpStatus.connected,
    mcpConnectingCount: mcpStatus.connecting,
    mcpErrorCount: mcpStatus.error,
    contextStats: state.contextStats,
  }
}

// 渲染顶部面板（横幅、工作目录、权限摘要、会话统计）
// Render the header panel (banner, working directory, permission summary, session stats)
function renderHeaderPanel(args: TtyAppArgs, state: ScreenState): string {
  return renderBanner(
    args.runtime,
    args.cwd,
    args.permissions.getSummary(),
    getSessionStats(args, state),
  )
}

// 渲染输入提示面板（输入行 + 斜杠命令菜单）
// Render the prompt panel (input line + slash command menu if visible)
function renderPromptPanel(state: ScreenState): string {
  const commands = getVisibleCommands(state.input)
  const promptBody = [
    renderInputPrompt(state.input, state.cursorOffset),
    commands.length > 0
      ? `\n${renderSlashMenu(
          commands,
          Math.min(state.selectedSlashIndex, commands.length - 1),
        )}`
      : '',
  ].join('')
  return renderPanel('prompt', promptBody)
}

// 计算转录面板主体区域可用的行数（从终端总行数减去其他面板高度）
// Compute the number of lines available for the transcript panel body (terminal rows minus other panels)
function getTranscriptBodyLines(args: TtyAppArgs, state: ScreenState): number {
  const rows = Math.max(24, process.stdout.rows ?? 40)
  const headerLines = renderHeaderPanel(args, state).split('\n').length
  const promptLines = renderPromptPanel(state).split('\n').length
  const footerLines = 1
  const gapsBetweenSections = 3
  const transcriptPanelFrameLines = 4
  const remaining =
    rows -
    headerLines -
    promptLines -
    footerLines -
    gapsBetweenSections -
    transcriptPanelFrameLines

  return Math.max(6, remaining)
}

// 计算转录面板的最大可滚动偏移量
// Compute the maximum scroll offset for the transcript panel
function getMaxTranscriptScrollOffset(args: TtyAppArgs, state: ScreenState): number {
  return getTranscriptMaxScrollOffset(
    state.transcript,
    getTranscriptBodyLines(args, state),
  )
}

// 将屏幕坐标 Y 转换为转录内容的绝对行索引
// Convert a screen Y coordinate to an absolute line index in the transcript content
function screenToAbsoluteLineIndex(
  _args: TtyAppArgs,
  state: ScreenState,
  screenY: number,
): number {
  const bodyStartY = state.transcriptBodyStartY
  const bodyY = screenY - bodyStartY
  if (bodyY < 0) return -1

  const lines = renderTranscriptLines(state.transcript)
  const pageSize = getTranscriptWindowSize(state.transcriptBodyLines)
  const maxOffset = Math.max(0, lines.length - pageSize)
  const offset = Math.max(0, Math.min(state.transcriptScrollOffset, maxOffset))
  const end = lines.length - offset
  const start = Math.max(0, end - pageSize)

  const lineIndex = start + bodyY
  if (lineIndex < 0) return -1
  if (lines.length === 0) return -1
  return Math.min(lineIndex, lines.length - 1)
}

// 根据操作系统平台编码剪贴板文本（Windows 需要 UTF-16LE BOM）
// Encode clipboard text for the target OS platform (Windows requires UTF-16LE with BOM)
export function encodeClipboardTextForPlatform(
  platform: NodeJS.Platform,
  text: string,
): string | Buffer {
  if (platform === 'win32') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
  }
  return text
}

// 将文本复制到系统剪贴板（通过调用系统原生工具）
// Copy text to the system clipboard via native OS tools (clip/pbcopy/xclip)
function copyToClipboard(text: string): void {
  try {
    const platform = process.platform
    const proc =
      platform === 'win32'
        ? spawn('clip', { stdio: ['pipe', 'inherit', 'inherit'] })
        : platform === 'darwin'
          ? spawn('pbcopy', { stdio: ['pipe', 'inherit', 'inherit'] })
          : spawn('xclip', ['-selection', 'clipboard'], {
              stdio: ['pipe', 'inherit', 'inherit'],
            })
    const payload = encodeClipboardTextForPlatform(platform, text)
    proc.stdin?.write(payload)
    proc.stdin?.end()
  } catch {
    // Silently fail if clipboard is unavailable
  }
}

// 按给定增量滚动转录面板，返回是否实际发生了滚动
// Scroll the transcript panel by a given delta, returns whether scrolling actually occurred
function scrollTranscriptBy(
  args: TtyAppArgs,
  state: ScreenState,
  delta: number,
): boolean {
  const nextOffset = Math.max(
    0,
    Math.min(
      getMaxTranscriptScrollOffset(args, state),
      state.transcriptScrollOffset + delta,
    ),
  )

  if (nextOffset === state.transcriptScrollOffset) {
    return false
  }

  state.transcriptScrollOffset = nextOffset
  return true
}

// 将转录面板跳转到顶部或底部边缘
// Jump the transcript panel to the top or bottom edge
function jumpTranscriptToEdge(
  args: TtyAppArgs,
  state: ScreenState,
  target: 'top' | 'bottom',
): boolean {
  const nextOffset =
    target === 'top' ? getMaxTranscriptScrollOffset(args, state) : 0
  if (nextOffset === state.transcriptScrollOffset) {
    return false
  }

  state.transcriptScrollOffset = nextOffset
  return true
}

// 获取待处理审批面板的最大滚动偏移量
// Get the maximum scroll offset for the pending approval panel
function getPendingApprovalMaxScrollOffset(state: ScreenState): number {
  const pending = state.pendingApproval
  if (!pending) return 0
  return getPermissionPromptMaxScrollOffset(pending.request, {
    expanded: pending.detailsExpanded,
  })
}

// 按给定增量滚动待处理审批面板，返回是否实际发生了滚动
// Scroll the pending approval panel by a given delta, returns whether scrolling actually occurred
function scrollPendingApprovalBy(state: ScreenState, delta: number): boolean {
  const pending = state.pendingApproval
  if (!pending || !pending.detailsExpanded) {
    return false
  }

  const maxOffset = getPendingApprovalMaxScrollOffset(state)
  const nextOffset = Math.max(
    0,
    Math.min(maxOffset, pending.detailsScrollOffset + delta),
  )
  if (nextOffset === pending.detailsScrollOffset) {
    return false
  }
  pending.detailsScrollOffset = nextOffset
  return true
}

// 切换待处理审批面板中编辑详情的展开/折叠状态
// Toggle the expand/collapse state of edit details in the pending approval panel
function togglePendingApprovalExpand(state: ScreenState): boolean {
  const pending = state.pendingApproval
  if (!pending || pending.request.kind !== 'edit') {
    return false
  }
  pending.detailsExpanded = !pending.detailsExpanded
  pending.detailsScrollOffset = 0
  return true
}

// 按给定增量移动待处理审批面板中的选中项
// Move the selection in the pending approval panel by a given delta
function movePendingApprovalSelection(state: ScreenState, delta: number): boolean {
  const pending = state.pendingApproval
  if (!pending || pending.feedbackMode) {
    return false
  }
  const total = pending.request.choices.length
  if (total <= 0) return false
  pending.selectedChoiceIndex =
    (pending.selectedChoiceIndex + delta + total) % total
  return true
}

// 在输入历史中向上导航（回到较早的输入），返回是否成功
// Navigate up through input history (to earlier inputs), returns whether successful
function historyUp(state: ScreenState): boolean {
  if (state.history.length === 0 || state.historyIndex <= 0) {
    return false
  }

  if (state.historyIndex === state.history.length) {
    state.historyDraft = state.input
  }

  state.historyIndex -= 1
  state.input = state.history[state.historyIndex] ?? ''
  state.cursorOffset = state.input.length
  return true
}

// 在输入历史中向下导航（回到较新的输入或草稿），返回是否成功
// Navigate down through input history (to newer inputs or draft), returns whether successful
function historyDown(state: ScreenState): boolean {
  if (state.historyIndex >= state.history.length) {
    return false
  }

  state.historyIndex += 1
  state.input =
    state.historyIndex === state.history.length
      ? state.historyDraft
      : (state.history[state.historyIndex] ?? '')
  state.cursorOffset = state.input.length
  return true
}

// 根据当前输入获取可见的斜杠命令列表（仅当输入以 / 开头时）
// Get the visible slash commands based on the current input (only when input starts with /)
function getVisibleCommands(input: string) {
  if (!input.startsWith('/')) return []
  if (input === '/') return SLASH_COMMANDS
  const matches = findMatchingSlashCommands(input)
  return SLASH_COMMANDS.filter(command => matches.includes(command.usage))
}

// 向转录面板追加一条新条目并返回其 ID
// Append a new entry to the transcript and return its assigned ID
function pushTranscriptEntry(
  state: ScreenState,
  entry: TranscriptEntryDraft,
): number {
  const id = state.nextEntryId++
  state.transcript.push({ id, ...entry })
  return id
}

// 更新转录中工具条目的状态和内容
// Update the status and body of a tool entry in the transcript
function updateToolEntry(
  state: ScreenState,
  entryId: number,
  status: 'running' | 'success' | 'error',
  body: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'tool',
  )

  if (!entry || entry.kind !== 'tool') {
    return
  }

  entry.status = status
  entry.body = body
  entry.collapsed = false
  entry.collapsedSummary = undefined
  entry.collapsePhase = undefined
}

// 将转录中的工具条目折叠为摘要视图
// Collapse a tool entry in the transcript into a summary view
function collapseToolEntry(
  state: ScreenState,
  entryId: number,
  summary: string,
): void {
  const entry = state.transcript.find(
    item => item.id === entryId && item.kind === 'tool',
  )
  if (!entry || entry.kind !== 'tool' || entry.status === 'running') {
    return
  }
  entry.collapsePhase = undefined
  entry.collapsed = true
  entry.collapsedSummary = summary
}

// 获取转录中所有仍在运行的工具条目
// Get all tool entries in the transcript that are still in 'running' status
function getRunningToolEntries(state: ScreenState): Array<Extract<TranscriptEntry, { kind: 'tool' }>> {
  return state.transcript.filter(
    (entry): entry is Extract<TranscriptEntry, { kind: 'tool' }> =>
      entry.kind === 'tool' && entry.status === 'running',
  )
}

// 将所有仍为运行状态且无结果的工具条目标记为错误
// Mark all dangling running tool entries as errors if they have no final result
function finalizeDanglingRunningTools(state: ScreenState): void {
  const runningEntries = getRunningToolEntries(state)
  for (const entry of runningEntries) {
    entry.status = 'error'
    entry.body = `${entry.body}\n\nERROR: Tool did not report a final result before the turn ended. This usually means the command kept running in the background or the tool lifecycle got out of sync.`
    entry.collapsed = false
    entry.collapsedSummary = undefined
    entry.collapsePhase = undefined
    state.recentTools.push({
      name: entry.toolName,
      status: 'error',
    })
  }
  if (runningEntries.length > 0) {
    state.activeTool = null
    state.status = `Previous turn ended with ${runningEntries.length} unfinished tool call(s).`
  }
}

// 为折叠的工具摘要生成一行摘要文本（取第一个非空行并截断）
// Generate a one-line summary for a collapsed tool body (first non-empty line, truncated)
function summarizeCollapsedToolBody(output: string): string {
  const line = output
    .split('\n')
    .map(item => item.trim())
    .find(Boolean)
  if (!line) {
    return 'output collapsed'
  }
  if (line.length > 140) {
    return `${line.slice(0, 140)}...`
  }
  return line
}

// 将文本截断至指定长度以用于显示
// Truncate text to a given maximum length for display purposes
function truncateForDisplay(text: string, max = 180): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

// 为工具调用输入生成人类可读的摘要（提取路径、命令等关键信息）
// Generate a human-readable summary of a tool call's input (extract path, command, etc.)
function summarizeToolInput(toolName: string, input: unknown): string {
  if (typeof input === 'string') {
    return truncateForDisplay(input.replace(/\s+/g, ' ').trim())
  }

  if (typeof input === 'object' && input !== null) {
    const maybePath = (input as { path?: unknown }).path
    const pathPart =
      typeof maybePath === 'string' && maybePath.trim()
        ? ` path=${maybePath}`
        : ''

    if (toolName === 'patch_file') {
      const count = Array.isArray((input as { replacements?: unknown }).replacements)
        ? (input as { replacements: unknown[] }).replacements.length
        : 0
      return `patch_file${pathPart} replacements=${count}`
    }

    if (toolName === 'edit_file') {
      return `edit_file${pathPart}`
    }

    if (toolName === 'read_file') {
      const offset = (input as { offset?: unknown }).offset
      const limit = (input as { limit?: unknown }).limit
      return `read_file${pathPart}${offset !== undefined ? ` offset=${String(offset)}` : ''}${limit !== undefined ? ` limit=${String(limit)}` : ''}`
    }

    if (toolName === 'run_command') {
      const command = (input as { command?: unknown }).command
      return `run_command${typeof command === 'string' ? ` ${truncateForDisplay(command, 120)}` : ''}`
    }
  }

  try {
    return truncateForDisplay(JSON.stringify(input))
  } catch {
    return truncateForDisplay(String(input))
  }
}

type AggregatedEditProgress = {
  entryId: number
  toolName: string
  path: string
  total: number
  completed: number
  errors: number
  lastOutput: string
}

// 判断给定的工具名是否属于文件编辑类工具
// Check whether a given tool name belongs to a file-editing tool category
function isFileEditTool(toolName: string): boolean {
  return (
    toolName === 'edit_file' ||
    toolName === 'patch_file' ||
    toolName === 'modify_file' ||
    toolName === 'write_file'
  )
}

// 从工具输入对象中提取文件路径字段
// Extract the file path field from a tool input object
function extractPathFromToolInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  if (!('path' in input)) {
    return null
  }
  const value = (input as { path?: unknown }).path
  return typeof value === 'string' && value.trim() ? value : null
}

// 全屏渲染 TUI：标题、转录、输入区、页脚（根据当前状态切换布局）
// Full-screen TUI render: header, transcript, prompt, footer (layout adapts to current state)
function renderScreen(args: TtyAppArgs, state: ScreenState): void {
  const backgroundTasks = listBackgroundTasks()
  clearScreen()
  const headerPanel = renderHeaderPanel(args, state)
  console.log(headerPanel)
  console.log('')
  state.transcriptBodyStartY = headerPanel.split('\n').length + 4
  state.transcriptBodyLines = getTranscriptBodyLines(args, state)

  if (state.pendingApproval) {
    console.log(
      renderPanel('approval', renderPermissionPrompt(state.pendingApproval.request, {
        expanded: state.pendingApproval.detailsExpanded,
        scrollOffset: state.pendingApproval.detailsScrollOffset,
        selectedChoiceIndex: state.pendingApproval.selectedChoiceIndex,
        feedbackMode: state.pendingApproval.feedbackMode,
        feedbackInput: state.pendingApproval.feedbackInput,
      })),
    )
    console.log('')
    console.log(renderPanel('activity', renderToolPanel(state.activeTool, state.recentTools, backgroundTasks)))
    console.log('')
    console.log(
      renderFooterBar(
        state.status,
        true,
        args.tools.getSkills().length > 0,
        summarizeMcpServers(args.tools.getMcpServers()),
        backgroundTasks,
        state.compressionStatus,
      ),
    )
    return
  }

  if (state.sessionPicker) {
    if (state.sessionPicker.allProjects) {
      const projects = state.sessionPicker.projects
      const lines = projects.map((p, i) => {
        const marker = i === state.sessionPicker!.projectSelectedIndex ? ' > ' : '   '
        const ago = formatRelativeTime(p.latestUpdatedAt)
        return `${marker}${p.dir}  ${p.sessionCount} sessions  ${ago}`
      })
      const body = `All projects:\n\n${lines.join('\n')}\n\nEnter to see info, Tab to go back, Esc to cancel`
      console.log(renderPanel('projects', body))
    } else {
      const lines = state.sessionPicker.sessions.map((s, i) => {
        const marker = i === state.sessionPicker!.selectedIndex ? ' > ' : '   '
        const title = s.title ? `  ${s.title}` : ''
        const ago = formatRelativeTime(s.updatedAt)
        const deleteTag = state.sessionPicker!.deleteConfirmIndex === i ? '  [DELETE? Press d again to confirm]' : ''
        return `${marker}${s.id}${title}  ${s.messageCount} messages  ${ago}${deleteTag}`
      })
      const body = `Select a session to resume:\n\n${lines.join('\n')}\n\n↑/↓ to select, Enter to resume, d to delete, Tab for all projects, Esc to cancel`
      console.log(renderPanel('sessions', body))
    }
    console.log('')
    console.log(
      renderFooterBar(
        state.status,
        true,
        args.tools.getSkills().length > 0,
        summarizeMcpServers(args.tools.getMcpServers()),
        backgroundTasks,
        state.compressionStatus,
      ),
    )
    return
  }

  console.log(
    renderPanel(
      'session feed',
      state.transcript.length > 0
        ? renderTranscript(
            state.transcript,
            state.transcriptScrollOffset,
            getTranscriptBodyLines(args, state),
            state.selection ?? undefined,
          )
        : `${renderStatusLine(null)}\n\nType /help for commands.`,
      {
        rightTitle: `${state.transcript.length} events`,
        minBodyLines: getTranscriptBodyLines(args, state),
      },
    ),
  )
  console.log('')
  console.log(renderPromptPanel(state))

  console.log('')
  console.log(
    renderFooterBar(
      state.status,
      true,
      args.tools.getSkills().length > 0,
      summarizeMcpServers(args.tools.getMcpServers()),
      backgroundTasks,
      state.compressionStatus,
    ),
  )
}

// 用最新的技能、MCP 服务器和权限信息刷新系统提示
// Refresh the system prompt with the latest skills, MCP servers, and permission summary
async function refreshSystemPrompt(args: TtyAppArgs): Promise<void> {
  args.messages[0] = {
    role: 'system',
    content: await buildSystemPrompt(args.cwd, args.permissions.getSummary(), {
      skills: args.tools.getSkills(),
      mcpServers: args.tools.getMcpServers(),
    }),
  }
}

// 从压缩结果中提取保留的消息（排除系统提示和摘要本身）
// Extract retained messages from a compression result (excluding system prompt and the summary)
function retainedMessagesAfterCompact(result: CompressionResult): ChatMessage[] {
  return result.messages.filter(message => (
    message.role !== 'system' && message !== result.summary
  ))
}

// 将上下文折叠结果持久化到会话日志，返回节省的 token 总数
// Persist context collapse spans to the session log, returning total tokens saved
async function persistContextCollapseResult(
  args: TtyAppArgs,
  result: ContextCollapseResult,
): Promise<number> {
  const spans = result.spans.length > 0
    ? result.spans
    : result.span
      ? [result.span]
      : []

  for (const span of spans) {
    await appendContextCollapseSpan(args.cwd, args.sessionId, span)
  }

  return spans.reduce(
    (sum, span) => sum + Math.max(0, span.tokensBefore - span.tokensAfter),
    0,
  )
}

// 执行本地工具快捷方式（直接在 TUI 内运行工具，不通过模型）
// Execute a local tool shortcut (run the tool directly in the TUI without going through the model)
async function executeToolShortcut(
  args: TtyAppArgs,
  state: ScreenState,
  toolName: string,
  input: unknown,
  rerender: () => void,
): Promise<void> {
  state.isBusy = true
  state.status = `Running ${toolName}...`
  state.activeTool = toolName
  const entryId = pushTranscriptEntry(state, {
    kind: 'tool',
    toolName,
    status: 'running',
    body: summarizeToolInput(toolName, input),
  })
  rerender()

  try {
    const result = await args.tools.execute(toolName, input, {
      cwd: args.cwd,
      permissions: args.permissions,
    })

    state.recentTools.push({
      name: toolName,
      status: result.ok ? 'success' : 'error',
    })
    updateToolEntry(
      state,
      entryId,
      result.ok ? 'success' : 'error',
      result.ok ? result.output : `ERROR: ${result.output}`,
    )
    collapseToolEntry(
      state,
      entryId,
      summarizeCollapsedToolBody(
        result.ok ? result.output : `ERROR: ${result.output}`,
      ),
    )
    state.transcriptScrollOffset = 0
  } finally {
    state.isBusy = false
    state.activeTool = null
    finalizeDanglingRunningTools(state)
    if (getRunningToolEntries(state).length === 0) {
      state.status = null
    }
  }
}

// 从持久化存储中恢复一个会话（加载消息、转录历史和折叠状态）
// Resume a session from persistent storage (load messages, transcript history, and collapse state)
async function resumeSession(
  args: TtyAppArgs,
  state: ScreenState,
  sessionId: string,
  loaded: ChatMessage[],
): Promise<void> {
  args.sessionId = sessionId
  const systemContent =
    args.messages[0]?.role === 'system' ? args.messages[0].content : ''
  await refreshSystemPrompt(args)
  args.messages.length = 0
  args.messages.push({ role: 'system', content: systemContent })
  args.messages.push(...loaded)
  state.transcript = []
  const persistedTranscript = await loadTranscript(args.cwd, sessionId)
  if (persistedTranscript && persistedTranscript.length > 0) {
    for (const entry of persistedTranscript) {
      pushTranscriptEntry(state, entry)
    }
  } else {
    for (const msg of loaded) {
      if (msg.role === 'user') {
        pushTranscriptEntry(state, { kind: 'user', body: msg.content })
      } else if (msg.role === 'assistant') {
        pushTranscriptEntry(state, { kind: 'assistant', body: msg.content })
      } else if (msg.role === 'assistant_tool_call') {
        pushTranscriptEntry(state, {
          kind: 'tool',
          toolName: msg.toolName,
          status: 'success',
          body: summarizeToolInput(msg.toolName, msg.input),
        })
      } else if (msg.role === 'context_summary') {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `[Context summary: ${msg.compressedCount} messages compressed]`,
        })
      } else if (msg.role === 'snip_boundary') {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Snipped earlier context: removed ${msg.removedCount} messages, freed ~${Math.round(msg.tokensFreed)} tokens.`,
        })
      }
    }
  }
  pushTranscriptEntry(state, {
    kind: 'assistant',
    body: `Session ${sessionId} resumed (${loaded.length} messages loaded).`,
  })
  args.alreadySavedCount = loaded.length
  args.contextCollapseState =
    await loadContextCollapseState(args.cwd, sessionId) ??
    createContextCollapseState()
  state.transcriptScrollOffset = 0
}

// 处理用户提交的输入：路由斜杠命令、工具快捷方式、或启动模型交互轮次
// Handle submitted user input: route slash commands, tool shortcuts, or initiate a model turn
async function handleInput(
  args: TtyAppArgs,
  state: ScreenState,
  rerender: () => void,
  submittedRawInput?: string,
): Promise<boolean> {
  if (state.isBusy) {
    state.status = state.activeTool
      ? `Running ${state.activeTool}...`
      : 'Current turn is still running...'
    return false
  }

  const input = (submittedRawInput ?? state.input).trim()
  if (!input) return false
  if (input === '/exit') return true

  // /collapse: persistent model-visible projection; original transcript remains intact
  if (input === '/collapse') {
    const model = args.runtime?.model ?? ''
    if (!model) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No model configured. Cannot collapse context.',
      })
      return false
    }

    state.isBusy = true
    state.status = 'Collapsing context...'
    state.compressionStatus = 'collapsing...'
    rerender()
    try {
      const result = await applyContextCollapseIfNeeded(
        args.messages,
        model,
        args.model,
        args.contextCollapseState ?? createContextCollapseState(),
        {
          utilizationThreshold: 0,
          reason: 'manual',
        },
      )
      args.contextCollapseState = result.state
      state.contextStats = computeContextStats(result.messages, model)

      if (result.collapsed) {
        const savedTokens = await persistContextCollapseResult(args, result)
        const spanCount = result.spans.length
        state.compressionStatus = `collapse saved ~${Math.round(savedTokens)} tokens`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context collapse projected ${spanCount} span${spanCount === 1 ? '' : 's'} into model-visible summaries. Original transcript is preserved.`,
        })
      } else {
        state.compressionStatus = result.state.enabled ? 'nothing safe to collapse' : 'collapse disabled'
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: result.state.enabled
            ? 'Nothing safe to collapse.'
            : 'Context collapse is disabled after repeated summary failures.',
        })
      }
    } catch (error) {
      state.compressionStatus = null
      const message = error instanceof Error ? error.message : String(error)
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Context collapse failed: ${message}`,
      })
    } finally {
      state.isBusy = false
      state.status = null
      state.transcriptScrollOffset = 0
      setTimeout(() => {
        state.compressionStatus = null
        rerender()
      }, 5000)
    }
    return false
  }

  // /snip: deterministic middle-context removal without calling the model
  if (input === '/snip') {
    const model = args.runtime?.model ?? ''
    const stats = computeContextStats(args.messages, model)
    const result = await snipCompactConversation({
      messages: args.messages,
      contextStats: stats,
      modelContextWindow: stats.effectiveInput,
    })

    if (!result.didSnip || result.boundaryMessage?.role !== 'snip_boundary') {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Nothing safe to snip.',
      })
      return false
    }

    await appendSnipBoundary(args.cwd, args.sessionId, result.boundaryMessage)
    args.messages.length = 0
    args.messages.push(...result.messages)
    args.alreadySavedCount = 0
    args.contextCollapseState = createContextCollapseState()
    state.contextStats = computeContextStats(args.messages, model)
    state.compressionStatus = `snip saved ~${Math.round(result.tokensFreed)} tokens`
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `Snipped earlier context: removed ${result.removedMessageIds.length} messages, freed ~${Math.round(result.tokensFreed)} tokens.`,
    })
    setTimeout(() => {
      state.compressionStatus = null
      rerender()
    }, 5000)
    return false
  }

  // /compact: manual context compression
  if (input === '/compact') {
    if (args.messages.length <= 2) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Not enough conversation to compress.',
      })
      return false
    }
    const model = args.runtime?.model ?? ''
    if (!model) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No model configured. Cannot compress.',
      })
      return false
    }
    state.isBusy = true
    state.status = 'Compressing context...'
    state.compressionStatus = 'compressing...'
    rerender()
    try {
      const result = await manualCompact(args.messages, args.model)
      if (result) {
        const summaryText = typeof result.summary.content === 'string' ? result.summary.content : ''
        await appendCompactBoundary(
          args.cwd,
          args.sessionId,
          summaryText,
          'manual',
          result.tokensBefore,
          result.tokensAfter,
          retainedMessagesAfterCompact(result),
        )
        args.messages.length = 0
        args.messages.push(...result.messages)
        args.alreadySavedCount = args.messages.length - 1
        args.contextCollapseState = createContextCollapseState()
        const savedPct = Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
        const savedTokens = result.tokensBefore - result.tokensAfter
        state.compressionStatus = `ctx -${savedPct}% (saved ${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens)`
        state.contextStats = computeContextStats(args.messages, model)
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context compressed: ${result.removedCount} messages summarized. ${savedPct}% reduction (${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens saved).`,
        })
      } else {
        state.compressionStatus = 'compression failed'
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: 'Could not compress further. The conversation may already be minimal.',
        })
      }
    } catch (error) {
      state.compressionStatus = null
      const message = error instanceof Error ? error.message : String(error)
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Compression failed: ${message}`,
      })
    } finally {
      state.isBusy = false
      state.status = null
      state.transcriptScrollOffset = 0
      // Clear compression status after a delay (will be reset on next render cycle)
      setTimeout(() => {
        state.compressionStatus = null
        rerender()
      }, 5000)
    }
    return false
  }

  if (input.startsWith('/rename ')) {
    const newName = input.slice('/rename '.length).trim()
    if (!newName) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'Usage: /rename <name>',
      })
      return false
    }
    const ok = await renameSession(args.cwd, args.sessionId, newName)
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: ok ? `Session renamed to "${newName}".` : 'No active session to rename.',
    })
    return false
  }

  if (input === '/resume' || input.startsWith('/resume ')) {
    const sessionIdArg = input.startsWith('/resume ') ? input.slice('/resume '.length).trim() : ''

    if (!sessionIdArg) {
      const sessions = await listSessions(args.cwd)
      if (sessions.length === 0) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: 'No saved sessions for this project.',
        })
        return false
      }

      const selectedId = await new Promise<string | null>(resolve => {
        state.sessionPicker = {
          sessions,
          selectedIndex: 0,
          resolve,
          deleteConfirmIndex: null,
          allProjects: false,
          projects: [],
          projectSelectedIndex: 0,
        }
        state.status = 'Select a session to resume'
        rerender()
      })

      state.sessionPicker = null
      state.status = null
      rerender()

      if (!selectedId) return false

      const loaded = await loadSession(args.cwd, selectedId)
      if (!loaded || loaded.length === 0) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Session ${selectedId} not found.`,
        })
        return false
      }
      await resumeSession(args, state, selectedId, loaded)
      return false
    }

    // Direct resume by id
    const loaded = await loadSession(args.cwd, sessionIdArg)
    if (!loaded || loaded.length === 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Session ${sessionIdArg} not found.`,
      })
      return false
    }
    await resumeSession(args, state, sessionIdArg, loaded)
    return false
  }

  if (input === '/new') {
    args.sessionId = crypto.randomUUID().slice(0, 8)
    args.alreadySavedCount = 0
    args.contextCollapseState = createContextCollapseState()
    state.transcript = []
    args.messages.length = 0
    await refreshSystemPrompt(args)
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: 'Session cleared. Starting fresh.',
    })
    return false
  }

  if (input === '/fork') {
    const newId = await forkSession(args.cwd, args.sessionId)
    if (!newId) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: 'No current session to fork.',
      })
      return false
    }
    args.sessionId = newId
    args.alreadySavedCount = args.messages.length - 1
    args.contextCollapseState = createContextCollapseState()
    state.transcriptScrollOffset = 0
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `Session forked. Now in session ${newId}. Original session preserved.`,
    })
    return false
  }

  if (state.history.at(-1) !== input) {
    state.history.push(input)
    await saveHistoryEntries(state.history, args.cwd, args.sessionId)
  }
  state.historyIndex = state.history.length
  state.historyDraft = ''

  if (input === '/tools') {
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: args.tools
        .list()
        .map(tool => `${tool.name}: ${tool.description}`)
        .join('\n'),
    })
    return false
  }

  const localCommandResult = await tryHandleLocalCommand(input, {
    tools: args.tools,
  })
  if (localCommandResult !== null) {
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: localCommandResult,
    })
    return false
  }

  const toolShortcut = parseLocalToolShortcut(input)
  if (toolShortcut) {
    await executeToolShortcut(
      args,
      state,
      toolShortcut.toolName,
      toolShortcut.input,
      rerender,
    )
    return false
  }

  if (input.startsWith('/')) {
    const matches = findMatchingSlashCommands(input)
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body:
        matches.length > 0
          ? `未识别命令。你是不是想输入：\n${matches.join('\n')}`
          : '未识别命令。输入 /help 查看可用命令。',
    })
    return false
  }

  await refreshSystemPrompt(args)
  args.messages.push({ role: 'user', content: input })
  pushTranscriptEntry(state, {
    kind: 'user',
    body: input,
  })
  state.transcriptScrollOffset = 0
  state.status = 'Thinking...'
  state.isBusy = true
  rerender()

  const pendingToolEntries = new Map<string, number[]>()
  const aggregatedEditByKey = new Map<string, AggregatedEditProgress>()
  const aggregatedEditByEntryId = new Map<number, AggregatedEditProgress>()

  args.permissions.beginTurn()
  try {
    const nextMessages = await runAgentTurn({
      model: args.model,
      tools: args.tools,
      messages: args.messages,
      cwd: args.cwd,
      permissions: args.permissions,
      modelName: args.runtime?.model ?? '',
      contentReplacementState: args.contentReplacementState,
      contextCollapseState: args.contextCollapseState,
      // 上下文统计更新回调：展示 token 使用情况和模型上下文窗口状态
      // Context stats update callback: display token usage and model context window status
      onContextStats(stats) {
        state.contextStats = stats
        rerender()
      },
      // 自动压缩回调：上下文使用率过高时触发 LLM 摘要压缩
      // Auto-compact callback: fires when context utilization is too high, performs LLM summarization
      async onAutoCompact(result) {
        const savedPct = Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)
        const savedTokens = result.tokensBefore - result.tokensAfter
        state.compressionStatus = `ctx -${savedPct}% (saved ${savedTokens >= 1000 ? `${Math.round(savedTokens / 1000)}K` : savedTokens} tokens)`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Context auto-compressed: ${result.removedCount} messages summarized.`,
        })
        const summaryText = typeof result.summary.content === 'string' ? result.summary.content : ''
        await appendCompactBoundary(
          args.cwd,
          args.sessionId,
          summaryText,
          'auto',
          result.tokensBefore,
          result.tokensAfter,
          retainedMessagesAfterCompact(result),
        )
        args.alreadySavedCount = result.messages.length - 1
        state.transcriptScrollOffset = 0
        setTimeout(() => {
          state.compressionStatus = null
          rerender()
        }, 5000)
      },
      // 上下文折叠回调：将不重要的历史 span 投射为模型可见摘要，不删除原始数据
      // Context collapse callback: project less important history spans into model-visible summaries without deleting originals
      async onContextCollapse(result) {
        if (result.collapsed) {
          const savedTokens = await persistContextCollapseResult(args, result)
          state.compressionStatus = `collapse saved ~${Math.round(savedTokens)} tokens`
          rerender()
          setTimeout(() => {
            state.compressionStatus = null
            rerender()
          }, 5000)
        }
      },
      // Snip 压缩回调：确定性移除中间上下文，不动模型，保护文件编辑和错误信息
      // Snip compact callback: deterministically remove middle context without calling the model, protecting file edits and errors
      async onSnipCompact(result) {
        if (result.boundaryMessage?.role === 'snip_boundary') {
          await appendSnipBoundary(args.cwd, args.sessionId, result.boundaryMessage)
        }
        args.alreadySavedCount = 0
        state.compressionStatus = `snip saved ~${Math.round(result.tokensFreed)} tokens`
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: `Snipped earlier context: removed ${result.removedMessageIds.length} messages, freed ~${Math.round(result.tokensFreed)} tokens.`,
        })
        state.transcriptScrollOffset = 0
        setTimeout(() => {
          state.compressionStatus = null
          rerender()
        }, 5000)
      },
      // 助手消息回调：将模型返回的文本消息追加到转录面板
      // Assistant message callback: append model text responses to the transcript panel
      onAssistantMessage(content) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: content,
        })
        state.transcriptScrollOffset = 0
        rerender()
      },
      // 进度消息回调：将模型返回的进度提示追加到转录面板
      // Progress message callback: append model progress notifications to the transcript panel
      onProgressMessage(content) {
        pushTranscriptEntry(state, {
          kind: 'progress',
          body: content,
        })
        state.transcriptScrollOffset = 0
        rerender()
      },
      // 工具启动回调：模型请求运行工具时，在转录中创建运行状态的工具条目（支持文件编辑聚合）
      // Tool start callback: when the model requests a tool, create a running tool entry in transcript (with file-edit aggregation)
      onToolStart(toolName, toolInput) {
        state.status = `Running ${toolName}...`
        state.activeTool = toolName
        let entryId: number
        const targetPath = extractPathFromToolInput(toolInput)
        const canAggregate = isFileEditTool(toolName) && targetPath !== null

        if (canAggregate) {
          const key = `${toolName}:${targetPath}`
          const existing = aggregatedEditByKey.get(key)
          if (existing) {
            existing.total += 1
            existing.lastOutput = summarizeToolInput(toolName, toolInput)
            entryId = existing.entryId
            updateToolEntry(
              state,
              entryId,
              existing.errors > 0 ? 'error' : 'running',
              `Aggregated ${toolName} for ${targetPath}\nCompleted: ${existing.completed}/${existing.total}`,
            )
          } else {
            entryId = pushTranscriptEntry(state, {
              kind: 'tool',
              toolName,
              status: 'running',
              body: summarizeToolInput(toolName, toolInput),
            })
            const progress: AggregatedEditProgress = {
              entryId,
              toolName,
              path: targetPath,
              total: 1,
              completed: 0,
              errors: 0,
              lastOutput: summarizeToolInput(toolName, toolInput),
            }
            aggregatedEditByKey.set(key, progress)
            aggregatedEditByEntryId.set(entryId, progress)
          }
        } else {
          entryId = pushTranscriptEntry(state, {
            kind: 'tool',
            toolName,
            status: 'running',
            body: summarizeToolInput(toolName, toolInput),
          })
        }
        const pending = pendingToolEntries.get(toolName) ?? []
        pending.push(entryId)
        pendingToolEntries.set(toolName, pending)
        state.transcriptScrollOffset = 0
        rerender()
      },
      // 工具结果回调：工具执行完成后更新转录中的工具条目状态（成功/错误）、折叠和最近工具列表
      // Tool result callback: after tool completes, update the tool entry status (success/error), collapse, and recent tools list
      onToolResult(toolName, output, isError) {
        const pending = pendingToolEntries.get(toolName) ?? []
        const entryId = pending.shift()
        pendingToolEntries.set(toolName, pending)
        if (entryId !== undefined) {
          const aggregated = aggregatedEditByEntryId.get(entryId)
          if (aggregated && aggregated.toolName === toolName) {
            aggregated.completed += 1
            if (isError) {
              aggregated.errors += 1
            }
            aggregated.lastOutput = output
            const done = aggregated.completed >= aggregated.total
            if (done) {
              state.recentTools.push({
                name: `${toolName} x${aggregated.total}`,
                status: aggregated.errors > 0 ? 'error' : 'success',
              })
            }
            const aggregatedBody = done
              ? [
                  `Aggregated ${toolName} for ${aggregated.path}`,
                  `Operations: ${aggregated.total}, errors: ${aggregated.errors}`,
                  `Last result: ${aggregated.lastOutput}`,
                ].join('\n')
              : `Aggregated ${toolName} for ${aggregated.path}\nCompleted: ${aggregated.completed}/${aggregated.total}`
            updateToolEntry(
              state,
              entryId,
              aggregated.errors > 0 ? 'error' : done ? 'success' : 'running',
              aggregatedBody,
            )
            if (done) {
              collapseToolEntry(
                state,
                entryId,
                summarizeCollapsedToolBody(aggregatedBody),
              )
              aggregatedEditByEntryId.delete(entryId)
              aggregatedEditByKey.delete(`${toolName}:${aggregated.path}`)
            }
          } else {
            state.recentTools.push({
              name: toolName,
              status: isError ? 'error' : 'success',
            })
            updateToolEntry(
              state,
              entryId,
              isError ? 'error' : 'success',
              isError ? `ERROR: ${output}` : output,
            )
            collapseToolEntry(
              state,
              entryId,
              summarizeCollapsedToolBody(
                isError ? `ERROR: ${output}` : output,
              ),
            )
          }
        } else {
          state.recentTools.push({
            name: toolName,
            status: isError ? 'error' : 'success',
          })
        }
        state.activeTool = null
        state.status = 'Thinking...'
        rerender()
      },
    })
    args.messages.length = 0
    args.messages.push(...nextMessages)
    await saveSession(args.cwd, args.sessionId, args.messages, args.alreadySavedCount)
    args.alreadySavedCount = args.messages.length - 1
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    args.messages.push({
      role: 'assistant',
      content: `请求失败: ${message}`,
    })
    pushTranscriptEntry(state, {
      kind: 'assistant',
      body: `请求失败: ${message}`,
    })
    state.transcriptScrollOffset = 0
  } finally {
    args.permissions.endTurn()
    state.isBusy = false
  }

  finalizeDanglingRunningTools(state)
  if (getRunningToolEntries(state).length === 0) {
    state.status = null
  }
  return false
}

// 创建一个处理权限请求的函数，将审批状态挂起并触发重新渲染
// Create a function that handles permission requests by setting pending approval state and re-rendering
function createPermissionPromptHandler(
  state: ScreenState,
  rerender: () => void,
): (request: PermissionRequest) => Promise<PermissionPromptResult> {
  return request =>
    new Promise(resolve => {
      state.pendingApproval = {
        request,
        resolve,
        detailsExpanded: false,
        detailsScrollOffset: 0,
        selectedChoiceIndex: 0,
        feedbackMode: false,
        feedbackInput: '',
      }
      state.status = 'Waiting for approval...'
      rerender()
    })
}

// 启动全屏交互式 TTY 应用的主循环（键盘/鼠标事件、渲染、会话管理）
// Launch the main loop of the full-screen interactive TTY application (keyboard/mouse events, rendering, session management)
export async function runTtyApp(args: TtyAppArgs): Promise<void> {
  enterAlternateScreen()
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  hideCursor()

  const state: ScreenState = {
    input: '',
    cursorOffset: 0,
    transcript: [],
    transcriptScrollOffset: 0,
    selectedSlashIndex: 0,
    status: null,
    activeTool: null,
    recentTools: [],
    history: await loadHistoryEntries(),
    historyIndex: 0,
    historyDraft: '',
    nextEntryId: 1,
    pendingApproval: null,
    sessionPicker: null,
    isBusy: false,
    contextStats: null,
    compressionStatus: null,
    selection: null,
    mouseDown: null,
    transcriptBodyStartY: 0,
    transcriptBodyLines: 20,
  }
  state.historyIndex = state.history.length

  const permissionArgs: TtyAppArgs = {
    ...args,
    contentReplacementState:
      args.contentReplacementState ?? createContentReplacementState(),
    contextCollapseState:
      args.contextCollapseState ?? createContextCollapseState(),
    permissions: new PermissionManager(
      args.cwd,
      createPermissionPromptHandler(state, () => renderScreen(permissionArgs, state)),
    ),
  }
  await permissionArgs.permissions.whenReady()
  if (
    permissionArgs.messages.length === 0 ||
    permissionArgs.messages[0]?.role !== 'system'
  ) {
    await refreshSystemPrompt(permissionArgs)
  }

  let deferredResumeInput: string | null = null
  if (permissionArgs.resumeTarget) {
    if (permissionArgs.resumeTarget === 'picker') {
      deferredResumeInput = '/resume'
    } else {
      await handleInput(
        permissionArgs,
        state,
        () => renderScreen(permissionArgs, state),
        `/resume ${permissionArgs.resumeTarget}`,
      )
    }
  } else {
    const expired = await cleanupExpiredSessions(args.cwd, 30 * 24 * 60 * 60 * 1000)
    if (expired > 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Cleaned up ${expired} expired session(s) (>30 days old).`,
      })
    }
    const sessions = await listSessions(args.cwd)
    if (sessions.length > 0) {
      pushTranscriptEntry(state, {
        kind: 'assistant',
        body: `Found ${sessions.length} saved session(s). Type /resume to continue one.`,
      })
    }
  }

  renderScreen(permissionArgs, state)

  await new Promise<void>(resolve => {
    let finished = false
    let inputRemainder = ''
    let eventChain = Promise.resolve()
    let submitInFlight = false

    // 清理资源并退出交互模式：移除事件监听、恢复终端设置
    // Clean up resources and exit interactive mode: remove event listeners, restore terminal settings
    const cleanup = () => {
      process.stdin.off('data', onData)
      process.stdin.off('end', onEnd)
      process.stdin.off('close', onClose)
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      showCursor()
      exitAlternateScreen()
      process.stdin.pause()
      process.stdout.write(`Session ${permissionArgs.sessionId} saved. To resume: codelite --resume ${permissionArgs.sessionId}\n`)
    }

    // 结束应用：防止重复调用，执行清理并 resolve 退出 Promise
    // Finish the application: prevent double-call, run cleanup, and resolve the exit promise
    const finish = () => {
      if (finished) return
      finished = true
      cleanup()
      resolve()
    }

    // 核心事件处理器：根据当前状态（审批/选会话/普通输入）路由键盘和鼠标事件
    // Core event handler: route keyboard and mouse events based on current state (approval/session-picker/normal input)
    const handleEvent = async (event: ParsedInputEvent) => {
      try {
        if (state.pendingApproval) {
          if (event.kind === 'text' && event.ctrl && event.text === 'o') {
            if (togglePendingApprovalExpand(state)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'text' && event.ctrl && event.text === 'c') {
            finish()
            return
          }

          if (event.kind === 'wheel') {
            if (
              event.direction === 'up'
                ? scrollPendingApprovalBy(state, -3)
                : scrollPendingApprovalBy(state, 3)
            ) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'pageup') {
            if (scrollPendingApprovalBy(state, -8)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'pagedown') {
            if (scrollPendingApprovalBy(state, 8)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'up' && event.meta) {
            if (scrollPendingApprovalBy(state, -1)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down' && event.meta) {
            if (scrollPendingApprovalBy(state, 1)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'up' && !event.meta) {
            if (movePendingApprovalSelection(state, -1)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down' && !event.meta) {
            if (movePendingApprovalSelection(state, 1)) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'backspace') {
            const pending = state.pendingApproval
            if (pending.feedbackMode && pending.feedbackInput.length > 0) {
              pending.feedbackInput = pending.feedbackInput.slice(0, -1)
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'text' && !event.ctrl && !event.meta) {
            const pending = state.pendingApproval
            if (!pending.feedbackMode) {
              const pressed = event.text.trim().toLowerCase()
              const matched = pending.request.choices.find(
                choice => choice.key.toLowerCase() === pressed,
              )
              if (matched) {
                if (matched.decision === 'deny_with_feedback') {
                  pending.feedbackMode = true
                  pending.feedbackInput = ''
                  renderScreen(permissionArgs, state)
                  return
                }

                state.pendingApproval = null
                state.status = null
                pending.resolve({ decision: matched.decision })
                renderScreen(permissionArgs, state)
                return
              }
            }

            if (pending.feedbackMode) {
              pending.feedbackInput += event.text
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'return') {
            const pending = state.pendingApproval
            if (pending.feedbackMode) {
              const feedback = pending.feedbackInput.trim()
              state.pendingApproval = null
              state.status = null
              pending.resolve({
                decision: 'deny_with_feedback',
                feedback,
              })
              renderScreen(permissionArgs, state)
              return
            }

            const selected =
              pending.request.choices[
                Math.min(
                  pending.selectedChoiceIndex,
                  pending.request.choices.length - 1,
                )
              ]
            if (!selected) {
              return
            }

            if (selected.decision === 'deny_with_feedback') {
              pending.feedbackMode = true
              pending.feedbackInput = ''
              renderScreen(permissionArgs, state)
              return
            }

            state.pendingApproval = null
            state.status = null
            pending.resolve({ decision: selected.decision })
            renderScreen(permissionArgs, state)
            return
          }

          if (event.kind === 'key' && event.name === 'escape') {
            const pending = state.pendingApproval
            if (pending.feedbackMode) {
              pending.feedbackMode = false
              pending.feedbackInput = ''
              renderScreen(permissionArgs, state)
              return
            }

            state.pendingApproval = null
            state.status = null
            pending.resolve({ decision: 'deny_once' })
            renderScreen(permissionArgs, state)
            return
          }

          return
        }

        if (state.sessionPicker) {
          if (event.kind === 'text' && event.ctrl && event.text === 'c') {
            state.sessionPicker.resolve(null)
            state.sessionPicker = null
            state.status = null
            renderScreen(permissionArgs, state)
            return
          }

          // All-projects view
          if (state.sessionPicker.allProjects) {
            if (event.kind === 'key' && event.name === 'up') {
              if (state.sessionPicker.projectSelectedIndex > 0) {
                state.sessionPicker.projectSelectedIndex -= 1
                renderScreen(permissionArgs, state)
              }
              return
            }

            if (event.kind === 'key' && event.name === 'down') {
              if (state.sessionPicker.projectSelectedIndex < state.sessionPicker.projects.length - 1) {
                state.sessionPicker.projectSelectedIndex += 1
                renderScreen(permissionArgs, state)
              }
              return
            }

            if (event.kind === 'key' && event.name === 'return') {
              const proj = state.sessionPicker.projects[state.sessionPicker.projectSelectedIndex]
              if (proj && proj.sessionCount > 0) {
                state.sessionPicker = null
                state.status = null
                pushTranscriptEntry(state, {
                  kind: 'assistant',
                  body: `Project "${proj.dir}" has ${proj.sessionCount} session(s). Switch to it by exiting and running:\n\n  cd <project-path> && codelite --resume`,
                })
                renderScreen(permissionArgs, state)
              }
              return
            }

            if ((event.kind === 'key' && event.name === 'tab') || (event.kind === 'key' && event.name === 'escape')) {
              state.sessionPicker.allProjects = false
              renderScreen(permissionArgs, state)
              return
            }

            return
          }

          // Session list view
          if (event.kind === 'key' && event.name === 'up') {
            const picker = state.sessionPicker
            if (picker.selectedIndex > 0) {
              picker.selectedIndex -= 1
              picker.deleteConfirmIndex = null
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'down') {
            const picker = state.sessionPicker
            if (picker.selectedIndex < picker.sessions.length - 1) {
              picker.selectedIndex += 1
              picker.deleteConfirmIndex = null
              renderScreen(permissionArgs, state)
            }
            return
          }

          if (event.kind === 'key' && event.name === 'return') {
            const picker = state.sessionPicker
            const selected = picker.sessions[picker.selectedIndex]
            const id = selected?.id ?? null
            state.sessionPicker = null
            state.status = null
            picker.resolve(id)
            renderScreen(permissionArgs, state)
            return
          }

          // 'd' to delete — first press marks, second press confirms
          if (event.kind === 'text' && !event.ctrl && !event.meta && event.text === 'd') {
            const picker = state.sessionPicker
            if (picker.deleteConfirmIndex === picker.selectedIndex) {
              // Second press — confirm delete
              const target = picker.sessions[picker.selectedIndex]
              if (target) {
                await clearSession(args.cwd, target.id)
                const sessions = await listSessions(args.cwd)
                if (sessions.length === 0) {
                  state.sessionPicker.resolve(null)
                  state.sessionPicker = null
                  state.status = null
                  renderScreen(permissionArgs, state)
                  return
                }
                picker.sessions = sessions
                picker.selectedIndex = Math.min(picker.selectedIndex, sessions.length - 1)
                picker.deleteConfirmIndex = null
              }
            } else {
              picker.deleteConfirmIndex = picker.selectedIndex
            }
            renderScreen(permissionArgs, state)
            return
          }

          // Tab — switch to all-projects view
          if (event.kind === 'key' && event.name === 'tab') {
            state.sessionPicker.allProjects = true
            state.sessionPicker.projects = await listAllProjects()
            state.sessionPicker.projectSelectedIndex = 0
            renderScreen(permissionArgs, state)
            return
          }

          if (event.kind === 'key' && event.name === 'escape') {
            state.sessionPicker.resolve(null)
            state.sessionPicker = null
            state.status = null
            renderScreen(permissionArgs, state)
            return
          }

          return
        }

        const visibleCommands = getVisibleCommands(state.input)

        if (event.kind === 'text' && event.ctrl && event.text === 'c') {
          finish()
          return
        }

        if (event.kind === 'wheel') {
          if (
              event.direction === 'up'
              ? scrollTranscriptBy(permissionArgs, state, 3)
              : scrollTranscriptBy(permissionArgs, state, -3)
          ) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'mouse') {
          const screenX = event.x + 1
          const screenY = event.y + 1
          const lineIndex = screenToAbsoluteLineIndex(permissionArgs, state, screenY)
          if (lineIndex < 0) {
            state.mouseDown = null
            state.selection = null
            return
          }
          const col = Math.max(0, screenX - 3)  // panel border (2) + content starts after left padding space

          if (event.action === 'press' && event.button === 'left') {
            state.mouseDown = { x: col, y: lineIndex }
            state.selection = null
            renderScreen(permissionArgs, state)
            return
          }

          if (event.action === 'drag' && event.button === 'left' && state.mouseDown) {
            const startLine = Math.min(state.mouseDown.y, lineIndex)
            const endLine = Math.max(state.mouseDown.y, lineIndex)
            const startCol =
              startLine === state.mouseDown.y
                ? Math.min(state.mouseDown.x, col)
                : state.mouseDown.y < lineIndex
                  ? state.mouseDown.x
                  : col
            const endCol =
              endLine === state.mouseDown.y
                ? Math.max(state.mouseDown.x, col)
                : state.mouseDown.y > lineIndex
                  ? state.mouseDown.x
                  : col

            state.selection = {
              startLine,
              startCol,
              endLine,
              endCol,
            }
            renderScreen(permissionArgs, state)
            return
          }

          if (event.action === 'release' && state.mouseDown) {
            if (state.selection) {
              const text = extractSelectedText(state.transcript, state.selection)
              if (text) {
                copyToClipboard(text)
              }
            }
            state.mouseDown = null
            state.selection = keepSelectionAfterMouseRelease(state.selection)
            renderScreen(permissionArgs, state)
            return
          }

          return
        }


        if (event.kind === 'key' && event.name === 'return') {
          if (state.isBusy) {
            state.status = state.activeTool
              ? `Running ${state.activeTool}...`
              : 'Current turn is still running...'
            renderScreen(permissionArgs, state)
            return
          }

          if (visibleCommands.length > 0) {
            const selected =
              visibleCommands[
                Math.min(state.selectedSlashIndex, visibleCommands.length - 1)
              ]
            if (selected && state.input.trim() !== selected.usage) {
              state.input = selected.usage
              state.cursorOffset = state.input.length
              state.selectedSlashIndex = 0
              renderScreen(permissionArgs, state)
              return
            }
          }

          const submittedInput = state.input
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          renderScreen(permissionArgs, state)
          if (submitInFlight) {
            return
          }
          submitInFlight = true
          void (async () => {
            try {
              const shouldExit = await handleInput(
                permissionArgs,
                state,
                () => renderScreen(permissionArgs, state),
                submittedInput,
              )
              if (shouldExit) {
                finish()
                return
              }
              renderScreen(permissionArgs, state)
            } catch (error) {
              pushTranscriptEntry(state, {
                kind: 'assistant',
                body: error instanceof Error ? error.message : String(error),
              })
              state.input = ''
              state.cursorOffset = 0
              state.selectedSlashIndex = 0
              state.status = null
              renderScreen(permissionArgs, state)
            } finally {
              submitInFlight = false
            }
          })()
          return
        }

        if (event.kind === 'key' && event.name === 'backspace') {
          if (state.cursorOffset > 0) {
            state.input =
              state.input.slice(0, state.cursorOffset - 1) +
              state.input.slice(state.cursorOffset)
            state.cursorOffset -= 1
          }
          state.selectedSlashIndex = 0
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'key' && event.name === 'delete') {
          state.input =
            state.input.slice(0, state.cursorOffset) +
            state.input.slice(state.cursorOffset + 1)
          state.selectedSlashIndex = 0
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'key' && event.name === 'tab') {
          if (visibleCommands.length > 0) {
            const selected =
              visibleCommands[
                Math.min(state.selectedSlashIndex, visibleCommands.length - 1)
              ]
            if (selected) {
              state.input = selected.usage
              state.cursorOffset = state.input.length
              state.selectedSlashIndex = 0
              renderScreen(permissionArgs, state)
            }
          }
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'p') {
          if (historyUp(state)) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'n') {
          if (historyDown(state)) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'key' && event.name === 'up') {
          if (visibleCommands.length > 0) {
            state.selectedSlashIndex =
              (state.selectedSlashIndex - 1 + visibleCommands.length) %
              visibleCommands.length
            renderScreen(permissionArgs, state)
          } else if (event.meta) {
            if (scrollTranscriptBy(permissionArgs, state, 1)) {
              renderScreen(permissionArgs, state)
            }
          } else if (historyUp(state)) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'key' && event.name === 'down') {
          if (visibleCommands.length > 0) {
            state.selectedSlashIndex =
              (state.selectedSlashIndex + 1) % visibleCommands.length
              renderScreen(permissionArgs, state)
          } else if (event.meta) {
            if (scrollTranscriptBy(permissionArgs, state, -1)) {
              renderScreen(permissionArgs, state)
            }
          } else if (historyDown(state)) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'key' && event.name === 'pageup') {
          if (scrollTranscriptBy(permissionArgs, state, 8)) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'key' && event.name === 'pagedown') {
          if (scrollTranscriptBy(permissionArgs, state, -8)) {
            renderScreen(permissionArgs, state)
          }
          return
        }

        if (event.kind === 'key' && event.name === 'left') {
          state.cursorOffset = Math.max(0, state.cursorOffset - 1)
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'key' && event.name === 'right') {
          state.cursorOffset = Math.min(state.input.length, state.cursorOffset + 1)
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'u') {
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'a') {
          if (!state.input) {
            if (jumpTranscriptToEdge(permissionArgs, state, 'top')) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          state.cursorOffset = 0
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'text' && event.ctrl && event.text === 'e') {
          if (!state.input) {
            if (jumpTranscriptToEdge(permissionArgs, state, 'bottom')) {
              renderScreen(permissionArgs, state)
            }
            return
          }

          state.cursorOffset = state.input.length
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'key' && event.name === 'escape') {
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          renderScreen(permissionArgs, state)
          return
        }

        if (event.kind === 'text' && !event.ctrl) {
          state.input =
            state.input.slice(0, state.cursorOffset) +
            event.text +
            state.input.slice(state.cursorOffset)
          state.cursorOffset += event.text.length
          state.selectedSlashIndex = 0
          state.historyIndex = state.history.length
          renderScreen(permissionArgs, state)
        }
      } catch (error) {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: error instanceof Error ? error.message : String(error),
        })
        state.input = ''
        state.cursorOffset = 0
        state.selectedSlashIndex = 0
        state.status = null
        renderScreen(permissionArgs, state)
      }
    }

    // stdin 数据事件处理：解析输入块并在事件链中有序处理每个已解析事件
    // stdin data event handler: parse input chunks and process each parsed event sequentially in the event chain
    const onData = (chunk: Buffer | string) => {
      const parsed = parseInputChunk(inputRemainder, chunk)
      inputRemainder = parsed.rest
      eventChain = eventChain.then(async () => {
        for (const event of parsed.events) {
          await handleEvent(event)
        }
      }).catch(error => {
        pushTranscriptEntry(state, {
          kind: 'assistant',
          body: error instanceof Error ? error.message : String(error),
        })
        state.input = ''
        state.cursorOffset = 0
        state.selectedSlashIndex = 0
        state.status = null
        renderScreen(permissionArgs, state)
      })
    }

    // stdin 流结束处理：触发应用退出
    // stdin stream end handler: trigger application exit
    const onEnd = () => finish()
    // stdin 流关闭处理：触发应用退出
    // stdin stream close handler: trigger application exit
    const onClose = () => finish()
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('close', onClose)

    // Handle deferred --resume (picker mode)
    if (deferredResumeInput) {
      const input = deferredResumeInput
      deferredResumeInput = null
      submitInFlight = true
      void (async () => {
        try {
          const shouldExit = await handleInput(
            permissionArgs,
            state,
            () => renderScreen(permissionArgs, state),
            input,
          )
          if (shouldExit) {
            finish()
            return
          }
          renderScreen(permissionArgs, state)
        } catch (error) {
          pushTranscriptEntry(state, {
            kind: 'assistant',
            body: error instanceof Error ? error.message : String(error),
          })
          state.input = ''
          state.cursorOffset = 0
          state.selectedSlashIndex = 0
          state.status = null
          renderScreen(permissionArgs, state)
        } finally {
          submitInFlight = false
        }
      })()
    }
  })
}
