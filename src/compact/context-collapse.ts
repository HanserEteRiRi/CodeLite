import type { ChatMessage, ModelAdapter } from '../types.js'
import {
  computeContextStats,
  estimateMessagesTokens,
  markProviderUsageStale,
} from '../utils/token-estimator.js'
import {
  CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES,
  CONTEXT_COLLAPSE_MAX_FAILURES,
  CONTEXT_COLLAPSE_MAX_SPANS_PER_PASS,
  CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
  CONTEXT_COLLAPSE_TARGET_USAGE,
  CONTEXT_COLLAPSE_UTILIZATION,
} from './constants.js'
import { parseSummaryFromResponse } from './prompt.js'

export type CollapseSpan = {
  id: string
  startMessageId: string
  endMessageId: string
  messageIds: string[]
  summary: string
  tokensBefore: number
  tokensAfter: number
  status: 'staged' | 'committed'
  createdAt: number
  reason: 'context_pressure' | 'manual' | 'overflow_recovery'
}

export type ContextCollapseState = {
  spans: CollapseSpan[]
  enabled: boolean
  consecutiveFailures: number
}

export type Model = string

export type ContextCollapseOptions = {
  utilizationThreshold: number
  targetUsage: number
  keepRecentMessages: number
  minTokensToSave: number
  currentTokens?: number
  effectiveInput?: number
  maxSpansPerPass: number
  maxFailures: number
  reason: CollapseSpan['reason']
}

export type CollapseCandidate = {
  startIndex: number
  endIndex: number
  startMessageId: string
  endMessageId: string
  messageIds: string[]
  messages: ChatMessage[]
  tokensBefore: number
  estimatedTokensAfter: number
  estimatedTokensToSave: number
}

type MessageGroup = {
  start: number
  end: number
  messages: ChatMessage[]
  tokens: number
  protected: boolean
}

export type ContextCollapseResult = {
  messages: ChatMessage[]
  state: ContextCollapseState
  collapsed: boolean
  span?: CollapseSpan
  spans: CollapseSpan[]
}

const CONTEXT_COLLAPSE_STALE_REASON =
  'conversation was context-collapsed in the model-visible projection after this provider usage was recorded'

// 创建初始化的上下文折叠状态对象
// Create an initialized context collapse state object
export function createContextCollapseState(): ContextCollapseState {
  return {
    spans: [],
    enabled: true,
    consecutiveFailures: 0,
  }
}

// 将状态对象标准化为纯数据副本（剥离可能的原型/方法引用）
// Normalize the state object into a plain data copy (strip potential prototype/method references)
function normalizeContextCollapseState(state: ContextCollapseState): ContextCollapseState {
  return {
    spans: [...state.spans],
    enabled: state.enabled,
    consecutiveFailures: state.consecutiveFailures,
  }
}

// 将部分选项与默认值合并，返回完整的 ContextCollapseOptions
// Merge partial options with defaults to produce a complete ContextCollapseOptions
function withDefaultOptions(
  options: Partial<ContextCollapseOptions> = {},
): ContextCollapseOptions {
  return {
    utilizationThreshold:
      options.utilizationThreshold ?? CONTEXT_COLLAPSE_UTILIZATION,
    targetUsage: options.targetUsage ?? CONTEXT_COLLAPSE_TARGET_USAGE,
    keepRecentMessages:
      options.keepRecentMessages ?? CONTEXT_COLLAPSE_KEEP_RECENT_MESSAGES,
    minTokensToSave:
      options.minTokensToSave ?? CONTEXT_COLLAPSE_MIN_TOKENS_TO_SAVE,
    currentTokens: options.currentTokens,
    effectiveInput: options.effectiveInput,
    maxSpansPerPass:
      options.maxSpansPerPass ?? CONTEXT_COLLAPSE_MAX_SPANS_PER_PASS,
    maxFailures: options.maxFailures ?? CONTEXT_COLLAPSE_MAX_FAILURES,
    reason: options.reason ?? 'context_pressure',
  }
}

// 获取消息 ID：优先使用 message.id，回退到基于索引生成的 ID
// Get the message ID: prefer message.id, fall back to index-based ID
function messageId(message: ChatMessage, index: number): string {
  return message.id ?? `message-${index}`
}

// 判断消息是否属于折叠边界（system、context_summary、snip_boundary 不可被折叠）
// Check whether a message is a collapse boundary (system, context_summary, snip_boundary are not collapsible)
function isCollapseBoundary(message: ChatMessage): boolean {
  return (
    message.role === 'system' ||
    message.role === 'context_summary' ||
    message.role === 'snip_boundary'
  )
}

// 估算折叠后的总结消息会消耗多少 token（约为原始 token 的 15%，最低 128）
// Estimate how many tokens the collapse summary will consume (~15% of original, min 128)
function estimateCollapseSummaryTokens(tokensBefore: number): number {
  return Math.max(128, Math.ceil(tokensBefore * 0.15))
}

// 构建折叠摘要的文本内容，包含说明头部和实际摘要
// Build the collapsed summary text content with explanatory header and actual summary
function buildCollapsedSummaryContent(span: CollapseSpan): string {
  return [
    '[Collapsed context summary]',
    `This summary replaces messages ${span.startMessageId} through ${span.endMessageId} in the model-visible context only.`,
    'The original transcript is preserved in the session/UI.',
    '',
    span.summary,
  ].join('\n')
}

// 基于折叠跨度创建一条 context_summary 角色消息
// Create a context_summary role message from a collapse span
function buildCollapsedSummaryMessage(
  span: CollapseSpan,
): Extract<ChatMessage, { role: 'context_summary' }> {
  return {
    id: `collapse-summary-${span.id}`,
    role: 'context_summary',
    content: buildCollapsedSummaryContent(span),
    compressedCount: span.messageIds.length,
    timestamp: span.createdAt,
  }
}

// 在消息数组中定位已提交的折叠跨度，返回其起止索引和对应的摘要消息
// Locate a committed collapse span in the message array, returning start/end indices and summary message
function projectSpan(
  messages: ChatMessage[],
  span: CollapseSpan,
): {
  start: number
  end: number
  message: Extract<ChatMessage, { role: 'context_summary' }>
} | null {
  if (span.status !== 'committed' || span.messageIds.length === 0) {
    return null
  }

  const indexById = new Map<string, number>()
  for (let i = 0; i < messages.length; i++) {
    indexById.set(messageId(messages[i]!, i), i)
  }

  const indices: number[] = []
  for (const id of span.messageIds) {
    const index = indexById.get(id)
    if (index === undefined) return null
    indices.push(index)
  }

  for (let i = 1; i < indices.length; i++) {
    if (indices[i] !== indices[i - 1]! + 1) {
      return null
    }
  }

  const start = indices[0]!
  const end = indices[indices.length - 1]! + 1
  if (
    messageId(messages[start]!, start) !== span.startMessageId ||
    messageId(messages[end - 1]!, end - 1) !== span.endMessageId
  ) {
    return null
  }

  return {
    start,
    end,
    message: buildCollapsedSummaryMessage(span),
  }
}

// 将原始消息数组投影为折叠后的视图：每个已提交的跨度被替换为一条摘要消息
// Project the original message array into a collapsed view: each committed span replaced by a summary message
export function projectCollapsedView(
  messages: ChatMessage[],
  state: ContextCollapseState,
): ChatMessage[] {
  if (!state.enabled || state.spans.length === 0) {
    return messages
  }

  const projections = state.spans
    .map(span => projectSpan(messages, span))
    .filter((projection): projection is NonNullable<typeof projection> => Boolean(projection))
    .sort((a, b) => a.start - b.start)

  if (projections.length === 0) {
    return messages
  }

  const result: ChatMessage[] = []
  const occupiedIndices = new Set<number>()
  let cursor = 0
  for (const projection of projections) {
    let overlaps = false
    for (let i = projection.start; i < projection.end; i++) {
      if (occupiedIndices.has(i)) {
        overlaps = true
        break
      }
    }
    if (overlaps) {
      continue
    }

    while (cursor < projection.start) {
      result.push(markProviderUsageStale(messages[cursor]!, CONTEXT_COLLAPSE_STALE_REASON))
      cursor += 1
    }
    result.push(projection.message)
    for (let i = projection.start; i < projection.end; i++) {
      occupiedIndices.add(i)
    }
    cursor = projection.end
  }

  while (cursor < messages.length) {
    result.push(markProviderUsageStale(messages[cursor]!, CONTEXT_COLLAPSE_STALE_REASON))
    cursor += 1
  }

  return result
}

// 将消息数组构建为消息组：将 thinking→tool_call→tool_result 聚合为一个受保护组
// Build message groups from the array: aggregate thinking→tool_call→tool_result into protected groups
function buildMessageGroups(messages: ChatMessage[]): MessageGroup[] {
  const groups: MessageGroup[] = []

  for (let i = 0; i < messages.length;) {
    const message = messages[i]!

    if (message.role === 'assistant_thinking') {
      const groupedMessages: ChatMessage[] = [message]
      let cursor = i + 1
      while (messages[cursor]?.role === 'assistant_tool_call') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      while (messages[cursor]?.role === 'tool_result') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      const hasToolCall = groupedMessages.some(msg => msg.role === 'assistant_tool_call')
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: hasToolCall && !toolGroupIsClosed(groupedMessages),
      })
      i = cursor
      continue
    }

    if (message.role === 'assistant_tool_call') {
      const groupedMessages: ChatMessage[] = []
      let cursor = i
      while (messages[cursor]?.role === 'assistant_tool_call') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      while (messages[cursor]?.role === 'tool_result') {
        groupedMessages.push(messages[cursor]!)
        cursor += 1
      }
      groups.push({
        start: i,
        end: cursor,
        messages: groupedMessages,
        tokens: estimateMessagesTokens(groupedMessages),
        protected: !toolGroupIsClosed(groupedMessages),
      })
      i = cursor
      continue
    }

    if (message.role === 'tool_result') {
      groups.push({
        start: i,
        end: i + 1,
        messages: [message],
        tokens: estimateMessagesTokens([message]),
        protected: true,
      })
      i += 1
      continue
    }

    groups.push({
      start: i,
      end: i + 1,
      messages: [message],
      tokens: estimateMessagesTokens([message]),
      protected: false,
    })
    i += 1
  }

  return groups
}

// 检查工具调用组是否已闭合：所有 tool_call 都有对应的 tool_result
// Check whether a tool call group is closed: all tool_calls have matching tool_results
function toolGroupIsClosed(messages: ChatMessage[]): boolean {
  const calls = new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { role: 'assistant_tool_call' }> => (
        message.role === 'assistant_tool_call'
      ))
      .map(message => message.toolUseId),
  )
  const results = new Set(
    messages
      .filter((message): message is Extract<ChatMessage, { role: 'tool_result' }> => (
        message.role === 'tool_result'
      ))
      .map(message => message.toolUseId),
  )

  if (calls.size === 0 && results.size === 0) return true
  if (calls.size === 0 || results.size === 0) return false
  for (const id of calls) {
    if (!results.has(id)) return false
  }
  for (const id of results) {
    if (!calls.has(id)) return false
  }
  return true
}

// 收集所有已提交或暂存的折叠跨度中包含的消息 ID 集合
// Collect message IDs from all committed or staged collapse spans into a Set
function committedCollapsedMessageIds(state: ContextCollapseState): Set<string> {
  const ids = new Set<string>()
  for (const span of state.spans) {
    if (span.status !== 'committed' && span.status !== 'staged') continue
    for (const id of span.messageIds) {
      ids.add(id)
    }
  }
  return ids
}

// 根据当前 token 数和目标利用率计算期望节省的 token 数量
// Calculate the desired number of tokens to save based on current tokens and target utilization
function desiredTokensToSave(options: ContextCollapseOptions): number {
  if (
    options.currentTokens !== undefined &&
    options.effectiveInput !== undefined &&
    options.effectiveInput > 0
  ) {
    return Math.max(
      options.minTokensToSave,
      Math.ceil(options.currentTokens - options.effectiveInput * options.targetUsage),
    )
  }
  return options.minTokensToSave
}

// 从消息组列表中构建折叠候选：累积足够 token 以满足期望节省量
// Build a collapse candidate from a message group list: accumulate enough tokens to meet desired savings
function buildCandidateFromGroups(
  messages: ChatMessage[],
  groups: MessageGroup[],
  options: ContextCollapseOptions,
): CollapseCandidate | null {
  const desired = desiredTokensToSave(options)
  let tokens = 0
  let endGroupIndex = -1

  for (let i = 0; i < groups.length; i++) {
    tokens += groups[i]!.tokens
    const estimatedTokensAfter = estimateCollapseSummaryTokens(tokens)
    const estimatedTokensToSave = Math.max(0, tokens - estimatedTokensAfter)
    endGroupIndex = i
    if (estimatedTokensToSave >= desired) {
      break
    }
  }

  if (endGroupIndex < 0) return null

  const selectedGroups = groups.slice(0, endGroupIndex + 1)
  const first = selectedGroups[0]!
  const last = selectedGroups[selectedGroups.length - 1]!
  const selectedMessages = messages.slice(first.start, last.end)
  const messageIds = selectedMessages.map((message, offset) => (
    messageId(message, first.start + offset)
  ))
  const estimatedTokensAfter = estimateCollapseSummaryTokens(tokens)
  const estimatedTokensToSave = Math.max(0, tokens - estimatedTokensAfter)

  if (estimatedTokensToSave < options.minTokensToSave) {
    return null
  }

  return {
    startIndex: first.start,
    endIndex: last.end,
    startMessageId: messageIds[0]!,
    endMessageId: messageIds[messageIds.length - 1]!,
    messageIds,
    messages: selectedMessages,
    tokensBefore: tokens,
    estimatedTokensAfter,
    estimatedTokensToSave,
  }
}

// 在消息中查找可折叠的候选范围：跳过受保护区域，在安全的连续组中寻找
// Find a collapsible candidate range in messages: skip protected regions, search within safe contiguous groups
export function findCollapseCandidate(
  messages: ChatMessage[],
  state: ContextCollapseState,
  rawOptions: Partial<ContextCollapseOptions> = {},
): CollapseCandidate | null {
  const options = withDefaultOptions(rawOptions)
  if (messages.length === 0) return null

  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIndex = i
      break
    }
  }

  const keepRecentStart = Math.max(0, messages.length - options.keepRecentMessages)
  const protectedStart = Math.min(
    keepRecentStart,
    lastUserIndex >= 0 ? lastUserIndex : messages.length,
  )
  if (protectedStart <= 0) return null

  const collapsedIds = committedCollapsedMessageIds(state)
  const groups = buildMessageGroups(messages)

  const safeRuns: MessageGroup[][] = []
  let currentRun: MessageGroup[] = []
  const flush = () => {
    if (currentRun.length > 0) {
      safeRuns.push(currentRun)
      currentRun = []
    }
  }

  for (const group of groups) {
    const protectedGroup =
      group.protected ||
      group.start < 0 ||
      group.end > protectedStart ||
      group.messages.some(isCollapseBoundary) ||
      group.messages.some((message, offset) => (
        collapsedIds.has(messageId(message, group.start + offset))
      ))

    if (protectedGroup) {
      flush()
      continue
    }
    currentRun.push(group)
  }
  flush()

  for (const run of safeRuns) {
    const candidate = buildCandidateFromGroups(messages, run, options)
    if (candidate) {
      return candidate
    }
  }

  return null
}

// 将单条消息转换为供折叠 LLM 阅读的文本表示
// Convert a single message to a text representation for the collapse LLM to read
function messageToCollapseText(message: ChatMessage): string {
  switch (message.role) {
    case 'user':
      return `[User]: ${message.content}`
    case 'assistant':
    case 'assistant_progress':
      return `[Assistant]: ${message.content}`
    case 'assistant_thinking':
      return '[Assistant Thinking]: preserved provider reasoning block'
    case 'assistant_tool_call':
      return `[Tool Call: ${message.toolName} ${message.toolUseId}]: ${JSON.stringify(message.input)}`
    case 'tool_result':
      return `[Tool Result: ${message.toolName} ${message.toolUseId}${message.isError ? ' ERROR' : ''}]: ${message.content}`
    case 'context_summary':
      return `[Context Summary]: ${message.content}`
    case 'snip_boundary':
      return `[Snip Boundary]: ${message.content}`
    case 'system':
      return '[System]: protected system message'
  }
}

// 将消息数组转换为供折叠 LLM 阅读的文本（每条消息用双换行分隔）
// Convert a message array to text for the collapse LLM (double-newline separated)
function messagesToCollapseText(messages: ChatMessage[]): string {
  return messages.map(messageToCollapseText).join('\n\n')
}

// 构建发送给 LLM 的上下文折叠总结提示词
// Build the context collapse summary prompt sent to the LLM
export function buildContextCollapseSummaryPrompt(conversationText: string): string {
  return `You are creating a local context-collapse summary for an AI coding session.
The summary will replace only this older message span in the model-visible context.
The original transcript remains preserved outside the model-visible projection.

Produce the final summary in <summary> tags.

Preserve:
- User intent and active goals
- Completed tasks and current state
- Important decisions and constraints
- Tool calls and tool results that still matter
- File reads/writes and code changes, with paths, function names, config names, and commands
- Errors, failures, warnings, and exact messages when relevant
- TODOs, uncertainty, follow-up constraints, and anything still relevant later

Rules:
- Do not invent facts or outcomes
- Do not omit critical paths, function names, configuration keys, file paths, or error text
- Keep it concise, but prefer specificity over vague compression
- This is not a full conversation compact; summarize only the provided span

Messages to summarize:

${conversationText}`
}

// 构建折叠失败的结果：递增连续失败次数，超出上限则禁用折叠
// Build a failed collapse result: increment consecutive failures, disable collapse if exceeding max
function failedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
  options: ContextCollapseOptions,
): ContextCollapseResult {
  const consecutiveFailures = state.consecutiveFailures + 1
  return {
    messages,
    state: {
      ...state,
      spans: [...state.spans],
      consecutiveFailures,
      enabled: consecutiveFailures >= options.maxFailures ? false : state.enabled,
    },
    collapsed: false,
    spans: [],
  }
}

// 构建无变化的结果：不需要或无法进行折叠
// Build an unchanged result: no collapse needed or possible
function unchangedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
): ContextCollapseResult {
  return {
    messages,
    state,
    collapsed: false,
    spans: [],
  }
}

// 将计划中的折叠跨度提交到状态中，重置失败计数，返回折叠后的消息视图
// Commit planned collapse spans into state, reset failure count, return collapsed message view
function committedCollapseResult(
  messages: ChatMessage[],
  state: ContextCollapseState,
  plannedSpans: CollapseSpan[],
): ContextCollapseResult {
  const committedSpans = plannedSpans.map(span => ({
    ...span,
    status: 'committed' as const,
  }))
  const nextState: ContextCollapseState = {
    ...state,
    spans: [...state.spans, ...committedSpans],
    consecutiveFailures: 0,
  }

  return {
    messages: projectCollapsedView(messages, nextState),
    state: nextState,
    collapsed: committedSpans.length > 0,
    span: committedSpans[0],
    spans: committedSpans,
  }
}

// 上下文折叠主入口：检查利用率，按需调用 LLM 创建折叠跨度并投影到折叠视图
// Context collapse main entry: check utilization, call LLM to create collapse spans, and project to collapsed view
export async function applyContextCollapseIfNeeded(
  messages: ChatMessage[],
  model: Model,
  adapter: ModelAdapter,
  state: ContextCollapseState,
  rawOptions: Partial<ContextCollapseOptions> = {},
): Promise<ContextCollapseResult> {
  const options = withDefaultOptions(rawOptions)
  const currentState = normalizeContextCollapseState(state)
  if (!currentState.enabled) {
    return unchangedCollapseResult(messages, currentState)
  }

  const currentProjected = projectCollapsedView(messages, currentState)
  let stats = computeContextStats(currentProjected, model)
  if (stats.utilization < options.utilizationThreshold) {
    return unchangedCollapseResult(currentProjected, currentState)
  }

  const plannedSpans: CollapseSpan[] = []
  const maxSpans = Math.max(1, Math.floor(options.maxSpansPerPass))

  for (let pass = 0; pass < maxSpans; pass++) {
    const selectionState: ContextCollapseState = {
      ...currentState,
      spans: [...currentState.spans, ...plannedSpans],
    }
    const projected = projectCollapsedView(messages, selectionState)
    stats = computeContextStats(projected, model)

    if (plannedSpans.length > 0 && stats.utilization <= options.targetUsage) {
      break
    }

    const candidate = findCollapseCandidate(messages, selectionState, {
      ...options,
      currentTokens: stats.totalTokens,
      effectiveInput: stats.effectiveInput,
    })
    if (!candidate) {
      break
    }

    const summaryPrompt = buildContextCollapseSummaryPrompt(
      messagesToCollapseText(candidate.messages),
    )
    const summaryRequestMessages: ChatMessage[] = [
      {
        role: 'system',
        content: 'You are a precise assistant that summarizes older coding-session context without inventing details.',
      },
      {
        role: 'user',
        content: summaryPrompt,
      },
    ]

    try {
      const response = await adapter.next(summaryRequestMessages)
      if (response.type !== 'assistant' || !response.content.trim()) {
        return failedCollapseResult(currentProjected, currentState, options)
      }

      const summary = parseSummaryFromResponse(response.content)
      if (!summary) {
        return failedCollapseResult(currentProjected, currentState, options)
      }

      const now = Date.now()
      const draftSpan: CollapseSpan = {
        id: `collapse-${now}-${pass}-${candidate.startMessageId}`,
        startMessageId: candidate.startMessageId,
        endMessageId: candidate.endMessageId,
        messageIds: candidate.messageIds,
        summary,
        tokensBefore: candidate.tokensBefore,
        tokensAfter: 0,
        status: 'staged',
        createdAt: now,
        reason: options.reason,
      }
      const summaryTokens = estimateMessagesTokens([buildCollapsedSummaryMessage(draftSpan)])
      const tokensToSave = Math.max(0, candidate.tokensBefore - summaryTokens)
      if (tokensToSave < options.minTokensToSave) {
        if (plannedSpans.length > 0) break
        return failedCollapseResult(currentProjected, currentState, options)
      }

      plannedSpans.push({
        ...draftSpan,
        tokensAfter: summaryTokens,
      })
    } catch {
      return failedCollapseResult(currentProjected, currentState, options)
    }
  }

  if (plannedSpans.length === 0) {
    return unchangedCollapseResult(currentProjected, currentState)
  }

  return committedCollapseResult(messages, currentState, plannedSpans)
}
