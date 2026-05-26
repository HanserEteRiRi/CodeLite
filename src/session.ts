import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { CODE_LITE_PROJECTS_DIR } from './config.js'
import type { ChatMessage } from './types.js'
import {
  createContextCollapseState,
  type CollapseSpan,
  type ContextCollapseState,
} from './compact/context-collapse.js'

const MAX_TITLE_LENGTH = 60

type EventType = 'system' | 'user' | 'assistant' | 'thinking' | 'progress' | 'tool_call' | 'tool_result' | 'summary' | 'compact_boundary' | 'snip_boundary' | 'context_collapse' | 'rename'

export type SnipBoundaryMetadata = {
  type: 'snip_boundary'
  removedMessageIds: string[]
  removedCount: number
  tokensFreed: number
  timestamp: string
  createdAt: string
}

type SessionEvent = {
  type: EventType
  message?: ChatMessage
  uuid: string
  timestamp: string
  sessionId: string
  cwd: string
  parentUuid: string | null
  logicalParentUuid?: string | null
  subtype?: string
  compactMetadata?: { trigger: string; preTokens: number; postTokens: number }
  snipMetadata?: SnipBoundaryMetadata
  contextCollapseSpan?: CollapseSpan
  title?: string
}

// 将工作目录路径转换为安全的项目目录名（替换路径分隔符）
// Convert a working directory path into a safe project directory name by replacing path separators
function projectDirName(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}

// 返回指定工作目录对应的项目会话存储目录路径
// Return the project session storage directory path for the given working directory
function projectDir(cwd: string): string {
  return path.join(CODE_LITE_PROJECTS_DIR, projectDirName(cwd))
}

// 返回指定会话的 JSONL 日志文件路径
// Return the JSONL log file path for a given session
function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(projectDir(cwd), `${sessionId}.jsonl`)
}

// 将消息角色字符串映射为会话事件类型
// Map a message role string to a session event type
function roleToType(role: string): EventType {
  switch (role) {
    case 'system': return 'system'
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'assistant_thinking': return 'thinking'
    case 'assistant_progress': return 'progress'
    case 'assistant_tool_call': return 'tool_call'
    case 'tool_result': return 'tool_result'
    case 'context_summary': return 'summary'
    case 'snip_boundary': return 'snip_boundary'
    default: return 'user'
  }
}

// 确保消息具有唯一 ID，若没有则自动生成并赋值
// Ensure a message has a unique ID; generate and assign one if missing
function ensureMessageId(message: ChatMessage): string {
  if (message.id) return message.id
  message.id = randomUUID()
  return message.id
}

// 将聊天消息包装为会话事件并序列化为 JSON 字符串
// Wrap a chat message into a session event and serialize it to a JSON string
function wrapEvent(message: ChatMessage, sessionId: string, cwd: string, parentUuid: string | null): string {
  const uuid = ensureMessageId(message)
  const event: SessionEvent = {
    type: roleToType(message.role),
    message,
    uuid,
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
    parentUuid,
  }
  if (message.role === 'snip_boundary') {
    event.snipMetadata = {
      type: 'snip_boundary',
      removedMessageIds: message.removedMessageIds,
      removedCount: message.removedCount,
      tokensFreed: message.tokensFreed,
      timestamp: event.timestamp,
      createdAt: event.timestamp,
    }
  }
  return JSON.stringify(event)
}

// 将一行 JSON 文本解析为会话事件对象，解析失败时返回 null
// Parse a line of JSON text into a session event object; return null on parse failure
function parseEvent(line: string): SessionEvent | null {
  try {
    return JSON.parse(line) as SessionEvent
  } catch {
    return null
  }
}

// 从会话事件中提取聊天消息，并将事件 UUID 设置为消息 ID
// Extract a chat message from a session event and set the event UUID as the message ID
function unwrapMessage(event: SessionEvent): ChatMessage | null {
  if (event.message) {
    return {
      ...event.message,
      id: event.uuid,
    } as ChatMessage
  }
  return null
}

// 重建被裁剪的事件序列：将被移除消息的 snip_boundary 插入到对应位置
// Reconstruct snipped event sequence by inserting snip_boundary events where messages were removed
function reconstructSnippedEvents(events: SessionEvent[]): SessionEvent[] {
  const snipEvents = events.filter(event => (
    event.type === 'snip_boundary' &&
    event.snipMetadata &&
    event.snipMetadata.removedMessageIds.length > 0
  ))

  if (snipEvents.length === 0) {
    return events
  }

  const removedIdToSnips = new Map<string, SessionEvent[]>()
  for (const snip of snipEvents) {
    for (const removedId of snip.snipMetadata!.removedMessageIds) {
      const existing = removedIdToSnips.get(removedId) ?? []
      existing.push(snip)
      removedIdToSnips.set(removedId, existing)
    }
  }

  const insertedSnips = new Set<string>()
  const result: SessionEvent[] = []

  for (const event of events) {
    if (event.type === 'snip_boundary') {
      continue
    }

    const snipsForRemovedEvent = removedIdToSnips.get(event.uuid) ?? []
    if (snipsForRemovedEvent.length > 0) {
      for (const snip of snipsForRemovedEvent) {
        if (!insertedSnips.has(snip.uuid)) {
          result.push(snip)
          insertedSnips.add(snip.uuid)
        }
      }
      continue
    }

    result.push(event)
  }

  return result
}

// 从事件行列表中提取会话标题：优先使用重命名事件，否则取第一条用户消息
// Extract a session title from event lines: prefer a rename event, otherwise use the first user message
function extractTitleFromEvents(lines: string[]): string | undefined {
  let renameTitle: string | undefined
  for (const line of lines) {
    const event = parseEvent(line)
    if (event?.type === 'rename' && typeof event.title === 'string') {
      renameTitle = event.title
    }
  }
  if (renameTitle) return renameTitle

  for (const line of lines) {
    const event = parseEvent(line)
    if (!event || event.type !== 'user') continue
    const content = (event.message as { content?: unknown } | null)?.content
    if (typeof content !== 'string' || !content.trim()) continue
    const text = content.trim()
    return text.length > MAX_TITLE_LENGTH ? text.slice(0, MAX_TITLE_LENGTH) + '...' : text
  }
  return undefined
}

// 读取会话文件中最后一条事件的 UUID，用于追加新事件时建立父子关系
// Read the UUID of the last event in a session file, used for parent-child linkage when appending
async function readLastEventUuid(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    if (lines.length === 0) return null
    const event = parseEvent(lines[lines.length - 1]!)
    return event?.uuid ?? null
  } catch {
    return null
  }
}

// 读取会话文件中所有已存在事件的 UUID 集合，用于去重判断
// Read all existing event UUIDs from a session file for deduplication checks
async function readExistingEventUuids(filePath: string): Promise<Set<string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const ids = new Set<string>()
    for (const line of content.trim().split('\n').filter(Boolean)) {
      const event = parseEvent(line)
      if (event?.uuid) {
        ids.add(event.uuid)
      }
    }
    return ids
  } catch {
    return new Set()
  }
}

// 将消息列表追加保存到会话 JSONL 文件，自动跳过已保存的消息
// Append-save message list to the session JSONL file, automatically skipping already-saved messages
export async function saveSession(
  cwd: string,
  sessionId: string,
  messages: ChatMessage[],
  alreadySavedCount: number = 0,
): Promise<void> {
  const dir = projectDir(cwd)
  const filePath = sessionFilePath(cwd, sessionId)
  await mkdir(dir, { recursive: true })

  const existingIds = await readExistingEventUuids(filePath)
  const nonSystemMessages = messages.slice(1)
  const toSave = nonSystemMessages.filter((message, index) => {
    if (message.id && existingIds.has(message.id)) {
      return false
    }
    if (message.id && !existingIds.has(message.id)) {
      return true
    }
    return index >= alreadySavedCount
  })
  if (toSave.length === 0) return

  let parentUuid = await readLastEventUuid(filePath)
  const lines: string[] = []
  for (const m of toSave) {
    const line = wrapEvent(m, sessionId, cwd, parentUuid)
    const parsed = JSON.parse(line) as SessionEvent
    parentUuid = parsed.uuid
    lines.push(line)
  }
  await appendFile(filePath, lines.join('\n') + '\n', 'utf8')
}

// 向会话文件追加一条 snip_boundary 事件，标记上下文被裁剪的位置
// Append a snip_boundary event to the session file, marking where context was snipped
export async function appendSnipBoundary(
  cwd: string,
  sessionId: string,
  boundaryMessage: Extract<ChatMessage, { role: 'snip_boundary' }>,
): Promise<void> {
  const dir = projectDir(cwd)
  const filePath = sessionFilePath(cwd, sessionId)
  await mkdir(dir, { recursive: true })

  const lastUuid = await readLastEventUuid(filePath)
  const now = new Date().toISOString()
  const uuid = ensureMessageId(boundaryMessage)

  const event: SessionEvent = {
    type: 'snip_boundary',
    subtype: 'snip_boundary',
    message: boundaryMessage,
    uuid,
    timestamp: now,
    sessionId,
    cwd,
    parentUuid: null,
    logicalParentUuid: lastUuid,
    snipMetadata: {
      type: 'snip_boundary',
      removedMessageIds: boundaryMessage.removedMessageIds,
      removedCount: boundaryMessage.removedCount,
      tokensFreed: boundaryMessage.tokensFreed,
      timestamp: now,
      createdAt: now,
    },
  }

  await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8')
}

// 向会话文件追加一条 context_collapse 事件，记录上下文折叠范围
// Append a context_collapse event to the session file, recording a context collapse span
export async function appendContextCollapseSpan(
  cwd: string,
  sessionId: string,
  span: CollapseSpan,
): Promise<void> {
  const dir = projectDir(cwd)
  const filePath = sessionFilePath(cwd, sessionId)
  await mkdir(dir, { recursive: true })

  const lastUuid = await readLastEventUuid(filePath)
  const now = new Date().toISOString()

  const event: SessionEvent = {
    type: 'context_collapse',
    subtype: 'context_collapse',
    uuid: span.id,
    timestamp: now,
    sessionId,
    cwd,
    parentUuid: null,
    logicalParentUuid: lastUuid,
    contextCollapseSpan: span,
  }

  await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8')
}

// 追加 compact_boundary 事件和摘要消息，记录上下文压缩操作
// Append a compact_boundary event and summary message, recording a context compaction operation
export async function appendCompactBoundary(
  cwd: string,
  sessionId: string,
  summaryText: string,
  trigger: 'auto' | 'manual',
  preTokens: number,
  postTokens: number,
  retainedMessages: ChatMessage[] = [],
): Promise<void> {
  const dir = projectDir(cwd)
  const filePath = sessionFilePath(cwd, sessionId)
  await mkdir(dir, { recursive: true })

  const lastUuid = await readLastEventUuid(filePath)
  const now = new Date().toISOString()

  const boundary: SessionEvent = {
    type: 'compact_boundary',
    subtype: 'compact_boundary',
    uuid: randomUUID(),
    timestamp: now,
    sessionId,
    cwd,
    parentUuid: null,
    logicalParentUuid: lastUuid,
    compactMetadata: { trigger, preTokens, postTokens },
  }

  const summary: SessionEvent = {
    type: 'user',
    message: { role: 'user', content: summaryText },
    uuid: randomUUID(),
    timestamp: now,
    sessionId,
    cwd,
    parentUuid: boundary.uuid,
  }

  const lines = [
    JSON.stringify(boundary),
    JSON.stringify(summary),
  ]
  let parentUuid = summary.uuid
  for (const message of retainedMessages) {
    const line = wrapEvent(message, sessionId, cwd, parentUuid)
    const parsed = JSON.parse(line) as SessionEvent
    parentUuid = parsed.uuid
    lines.push(line)
  }

  await appendFile(filePath, lines.join('\n') + '\n', 'utf8')
}

// 从 JSONL 文件加载会话消息列表，自动回放到最后一个 compact_boundary 之后
// Load a session message list from a JSONL file, automatically replaying from the last compact_boundary
export async function loadSession(
  cwd: string,
  sessionId: string,
): Promise<ChatMessage[] | null> {
  try {
    const content = await readFile(sessionFilePath(cwd, sessionId), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)

    // Find last compact_boundary
    let lastBoundaryIndex = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = parseEvent(lines[i]!)
      if (event?.type === 'compact_boundary') {
        lastBoundaryIndex = i
        break
      }
    }

    const startLine = lastBoundaryIndex >= 0 ? lastBoundaryIndex + 1 : 0
    const activeEvents: SessionEvent[] = []
    for (let i = startLine; i < lines.length; i++) {
      const event = parseEvent(lines[i]!)
      if (event) activeEvents.push(event)
    }

    const messages: ChatMessage[] = []
    for (const event of reconstructSnippedEvents(activeEvents)) {
      const msg = unwrapMessage(event)
      if (msg) messages.push(msg)
    }

    return messages.length > 0 ? messages : null
  } catch {
    return null
  }
}

// 从会话文件加载已提交的上下文折叠状态
// Load committed context collapse state from the session file
export async function loadContextCollapseState(
  cwd: string,
  sessionId: string,
): Promise<ContextCollapseState | null> {
  try {
    const content = await readFile(sessionFilePath(cwd, sessionId), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)

    let lastBoundaryIndex = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      const event = parseEvent(lines[i]!)
      if (event?.type === 'compact_boundary') {
        lastBoundaryIndex = i
        break
      }
    }

    const state = createContextCollapseState()
    for (let i = lastBoundaryIndex + 1; i < lines.length; i++) {
      const event = parseEvent(lines[i]!)
      if (event?.type !== 'context_collapse' || !event.contextCollapseSpan) {
        continue
      }
      if (event.contextCollapseSpan.status !== 'committed') {
        continue
      }
      state.spans.push(event.contextCollapseSpan)
    }

    return state.spans.length > 0 ? state : null
  } catch {
    return null
  }
}

// 删除指定会话的 JSONL 文件，并在目录为空时清理项目目录
// Delete the session JSONL file and clean up the project directory if it becomes empty
export async function clearSession(
  cwd: string,
  sessionId: string,
): Promise<void> {
  try {
    await unlink(sessionFilePath(cwd, sessionId))
  } catch {
    // ignore
  }

  try {
    const dir = projectDir(cwd)
    const files = await readdir(dir)
    if (files.length === 0) {
      await rm(dir, { recursive: true, force: true })
    }
  } catch {
    // ignore
  }
}

export type SessionMeta = {
  id: string
  title: string | undefined
  messageCount: number
  updatedAt: number
}

// 列出当前工作目录下的所有会话，按最后更新时间降序排列
// List all sessions for the current working directory, sorted by last-updated time descending
export async function listSessions(cwd: string): Promise<SessionMeta[]> {
  const dir = projectDir(cwd)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const matched = entries.filter(name => name.endsWith('.jsonl'))
  const results: SessionMeta[] = []

  for (const name of matched) {
    const id = name.slice(0, -'.jsonl'.length)
    const filePath = path.join(dir, name)
    try {
      const stats = await stat(filePath)
      const content = await readFile(filePath, 'utf8')
      const lines = content.trim().split('\n').filter(Boolean)
      const title = extractTitleFromEvents(lines)

      results.push({
        id,
        title,
        messageCount: lines.length,
        updatedAt: stats.mtime.getTime(),
      })
    } catch {
      // skip unreadable files
    }
  }

  results.sort((a, b) => b.updatedAt - a.updatedAt)
  return results
}

// 通过追加 rename 事件为会话设置新标题
// Rename a session by appending a rename event with the new title
export async function renameSession(
  cwd: string,
  sessionId: string,
  newTitle: string,
): Promise<boolean> {
  try {
    await readFile(sessionFilePath(cwd, sessionId))
  } catch {
    return false
  }

  const event = JSON.stringify({
    type: 'rename',
    title: newTitle,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId,
    cwd,
  })
  await mkdir(projectDir(cwd), { recursive: true })
  await appendFile(sessionFilePath(cwd, sessionId), event + '\n', 'utf8')
  return true
}

// 复制当前会话创建一个独立的派生会话副本
// Fork the current session into a new independent copy
export async function forkSession(
  cwd: string,
  sessionId: string,
): Promise<string | null> {
  const loaded = await loadSession(cwd, sessionId)
  if (!loaded || loaded.length === 0) return null

  const newId = randomUUID().slice(0, 8)
  await saveSession(cwd, newId, [{ role: 'system', content: '' }, ...loaded])

  // Determine fork title
  const allSessions = await listSessions(cwd)
  const source = allSessions.find(s => s.id === sessionId)
  const baseTitle = source?.title ?? 'session'
  const forkPrefix = baseTitle + '_fork'
  const existingForkNums = allSessions
    .filter(s => s.title?.startsWith(forkPrefix))
    .map(s => {
      const num = s.title!.slice(forkPrefix.length)
      return parseInt(num, 10)
    })
    .filter(n => !isNaN(n))
  const nextNum = existingForkNums.length > 0 ? Math.max(...existingForkNums) + 1 : 1
  await renameSession(cwd, newId, `${baseTitle}_fork${nextNum}`)

  return newId
}

// 清理超过最大保留时间的过期会话文件
// Clean up session files older than the maximum retention age
export async function cleanupExpiredSessions(
  cwd: string,
  maxAgeMs: number,
): Promise<number> {
  const dir = projectDir(cwd)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return 0
  }

  const now = Date.now()
  let removed = 0
  for (const name of entries.filter(e => e.endsWith('.jsonl'))) {
    const filePath = path.join(dir, name)
    try {
      const stats = await stat(filePath)
      if (now - stats.mtime.getTime() > maxAgeMs) {
        await unlink(filePath)
        removed += 1
      }
    } catch {
      // skip
    }
  }

  // Clean up empty directory
  try {
    const remaining = await readdir(dir)
    if (remaining.length === 0) {
      await rm(dir, { recursive: true, force: true })
    }
  } catch {
    // ignore
  }

  return removed
}

export type ProjectMeta = {
  dir: string
  sessionCount: number
  latestUpdatedAt: number
}

// 列出所有历史项目及其会话统计信息
// List all historical projects with their session statistics
export async function listAllProjects(): Promise<ProjectMeta[]> {
  let entries: string[]
  try {
    entries = await readdir(CODE_LITE_PROJECTS_DIR)
  } catch {
    return []
  }

  const results: ProjectMeta[] = []
  for (const name of entries) {
    const dirPath = path.join(CODE_LITE_PROJECTS_DIR, name)
    try {
      const stats = await stat(dirPath)
      if (!stats.isDirectory()) continue
      const files = await readdir(dirPath)
      const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
      if (jsonlFiles.length === 0) continue

      let latestUpdatedAt = 0
      for (const f of jsonlFiles) {
        const fstats = await stat(path.join(dirPath, f))
        if (fstats.mtime.getTime() > latestUpdatedAt) {
          latestUpdatedAt = fstats.mtime.getTime()
        }
      }

      results.push({
        dir: name,
        sessionCount: jsonlFiles.length,
        latestUpdatedAt,
      })
    } catch {
      // skip
    }
  }

  results.sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt)
  return results
}

export type PersistedTranscriptEntry =
  | { kind: 'user' | 'assistant' | 'progress'; body: string }
  | { kind: 'tool'; body: string; toolName: string; status: 'running' | 'success' | 'error' }

// 加载会话的人类可读文字记录，将原始事件转换为结构化的对话条目
// Load a human-readable transcript of the session, converting raw events into structured dialogue entries
export async function loadTranscript(
  cwd: string,
  sessionId: string,
): Promise<PersistedTranscriptEntry[] | null> {
  try {
    const content = await readFile(sessionFilePath(cwd, sessionId), 'utf8')
    const lines = content.trim().split('\n').filter(Boolean)
    const entries: PersistedTranscriptEntry[] = []

    const events = reconstructSnippedEvents(
      lines
        .map(line => parseEvent(line))
        .filter((event): event is SessionEvent => Boolean(event)),
    )

    for (const event of events) {

      const msg = (event.message ?? {}) as Record<string, unknown>

      switch (event.type) {
        case 'user':
          entries.push({ kind: 'user', body: typeof msg.content === 'string' ? msg.content : '' })
          break
        case 'assistant':
          entries.push({ kind: 'assistant', body: typeof msg.content === 'string' ? msg.content : '' })
          break
        case 'progress':
          entries.push({ kind: 'progress', body: typeof msg.content === 'string' ? msg.content : '' })
          break
        case 'tool_call':
          entries.push({
            kind: 'tool',
            toolName: typeof msg.toolName === 'string' ? msg.toolName : 'unknown',
            status: 'success',
            body: JSON.stringify(msg.input ?? ''),
          })
          break
        case 'summary':
          entries.push({
            kind: 'assistant',
            body: `[Context summary: ${msg.compressedCount ?? 0} messages compressed]`,
          })
          break
        case 'compact_boundary':
          entries.push({
            kind: 'assistant',
            body: `[Context compacted: ${event.compactMetadata?.preTokens ?? '?'} → ${event.compactMetadata?.postTokens ?? '?'} tokens]`,
          })
          break
        case 'snip_boundary':
          entries.push({
            kind: 'assistant',
            body: `[Snipped earlier context: removed ${event.snipMetadata?.removedCount ?? '?'} messages, freed ~${event.snipMetadata?.tokensFreed ?? '?'} tokens]`,
          })
          break
      }
    }

    return entries.length > 0 ? entries : null
  } catch {
    return null
  }
}
