import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { CODE_LITE_DIR } from '../config.js'
import type { ChatMessage } from '../types.js'

export const TOOL_RESULTS_SUBDIR = 'tool-results'
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000
export const MAX_TOOL_RESULTS_PER_BATCH_CHARS = 200_000
export const PREVIEW_SIZE_CHARS = 2_000

export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export type ToolResultReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type PendingToolResult = Extract<ChatMessage, { role: 'tool_result' }>

type ReplacementCandidate = {
  toolUseId: string
  content: string
  size: number
}

// 创建用于跟踪工具结果替换内容的状态容器
// Create a state container for tracking tool-result content replacements
export function createContentReplacementState(): ContentReplacementState {
  return {
    seenIds: new Set(),
    replacements: new Map(),
  }
}

// 清理路径片段，将非法字符替换为下划线，确保文件系统兼容
// Sanitize a path segment by replacing illegal characters with underscores
function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]/g, '_')
  return sanitized.length > 0 ? sanitized : randomUUID()
}

const sessionId = sanitizePathSegment(randomUUID())

// 获取当前会话的工具结果存储目录路径
// Get the tool-results storage directory path for the current session
function getToolResultsDir(): string {
  return path.join(CODE_LITE_DIR, TOOL_RESULTS_SUBDIR, sessionId)
}

// 根据工具调用 ID 生成带路径遍历防护的存储文件路径
// Generate a storage file path from a tool-use ID with path-traversal protection
function getToolResultPath(toolUseId: string): string {
  const dir = getToolResultsDir()
  const filepath = path.resolve(dir, `${sanitizePathSegment(toolUseId)}.txt`)
  const relative = path.relative(dir, filepath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return path.join(dir, `${randomUUID()}.txt`)
  }
  return filepath
}

// 判断内容是否已经是持久化输出格式（即已被替换过的）
// Check if content is already in the persisted-output format (previously replaced)
function isAlreadyPersistedOutput(content: string): boolean {
  return content.startsWith(PERSISTED_OUTPUT_TAG)
}

// 从长文本中截取预览片段，优先在换行处截断
// Generate a preview snippet from long content, preferring newline boundaries
function generatePreview(content: string): { preview: string; hasMore: boolean } {
  if (content.length <= PREVIEW_SIZE_CHARS) {
    return { preview: content, hasMore: false }
  }

  const truncated = content.slice(0, PREVIEW_SIZE_CHARS)
  const lastNewline = truncated.lastIndexOf('\n')
  const cutPoint = lastNewline > PREVIEW_SIZE_CHARS * 0.5
    ? lastNewline
    : PREVIEW_SIZE_CHARS

  return {
    preview: content.slice(0, cutPoint),
    hasMore: true,
  }
}

// 将字符数量格式化为人类可读的字符串（如 "1.5M chars"）
// Format a character count into a human-readable string (e.g. "1.5M chars")
function formatChars(chars: number): string {
  if (chars >= 1_000_000) return `${(chars / 1_000_000).toFixed(1)}M chars`
  if (chars >= 1_000) return `${Math.round(chars / 1_000)}K chars`
  return `${chars} chars`
}

// 将任意类型的工具结果内容规范化为字符串
// Normalize tool-result content of any type into a string
export function normalizeToolResultContent(content: unknown): string {
  if (content == null) return ''
  return typeof content === 'string' ? content : String(content)
}

// 将工具结果内容写入磁盘文件，返回文件路径和预览信息
// Write tool-result content to disk and return the file path with preview info
async function persistToolResult(
  content: string,
  toolUseId: string,
): Promise<{ filepath: string; originalSize: number; preview: string; hasMore: boolean } | null> {
  const filepath = getToolResultPath(toolUseId)
  try {
    await mkdir(path.dirname(filepath), { recursive: true })
    await writeFile(filepath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code !== 'EEXIST') {
      return null
    }
  }

  const { preview, hasMore } = generatePreview(content)
  return {
    filepath,
    originalSize: content.length,
    preview,
    hasMore,
  }
}

// 构建持久化输出提示消息，包含文件路径、大小和内容预览
// Build a persisted-output placeholder message with file path, size, and preview
function buildPersistedToolResultMessage(result: {
  filepath: string
  originalSize: number
  preview: string
  hasMore: boolean
}): string {
  const parts = [
    PERSISTED_OUTPUT_TAG,
    `Output too large (${formatChars(result.originalSize)}). Full output saved to: ${result.filepath}`,
    '',
    `Preview (first ${formatChars(PREVIEW_SIZE_CHARS)}):`,
    result.preview,
  ]

  if (result.hasMore) {
    parts.push('...')
  }

  parts.push(PERSISTED_OUTPUT_CLOSING_TAG)
  return parts.join('\n')
}

// 如果工具结果内容超过阈值，将其持久化到磁盘并在消息中替换为引用标记
// Replace over-size tool results with a disk-persisted reference when exceeding threshold
export async function replaceLargeToolResult(
  result: Omit<PendingToolResult, 'content'> & { content: unknown },
  stateOrThreshold?: ContentReplacementState | number,
  maybeThreshold = DEFAULT_MAX_RESULT_SIZE_CHARS,
): Promise<PendingToolResult> {
  const state =
    typeof stateOrThreshold === 'number' ? undefined : stateOrThreshold
  const threshold =
    typeof stateOrThreshold === 'number' ? stateOrThreshold : maybeThreshold
  const content = normalizeToolResultContent(result.content)
  const normalizedResult: PendingToolResult = {
    ...result,
    content,
  }

  const previousReplacement = state?.replacements.get(result.toolUseId)
  if (previousReplacement !== undefined) {
    return {
      ...normalizedResult,
      content: previousReplacement,
    }
  }

  if (content.trim().length === 0) {
    state?.seenIds.add(result.toolUseId)
    return {
      ...normalizedResult,
      content: `(${result.toolName} completed with no output)`,
    }
  }

  if (isAlreadyPersistedOutput(content)) {
    state?.seenIds.add(result.toolUseId)
    state?.replacements.set(result.toolUseId, content)
    return normalizedResult
  }

  if (content.length <= threshold) {
    return normalizedResult
  }

  const persisted = await persistToolResult(content, result.toolUseId)
  if (!persisted) {
    return normalizedResult
  }

  const replacement = buildPersistedToolResultMessage(persisted)
  state?.seenIds.add(result.toolUseId)
  state?.replacements.set(result.toolUseId, replacement)

  return {
    ...normalizedResult,
    content: replacement,
  }
}

// 按预算限制处理一批工具结果：优先替换最大的结果以控制总可见字符数
// Process a batch of tool results under a budget: replace the largest first to cap total visible chars
export async function applyToolResultBudget(
  results: PendingToolResult[],
  state: ContentReplacementState,
  limit = MAX_TOOL_RESULTS_PER_BATCH_CHARS,
): Promise<{
  results: PendingToolResult[]
  newlyReplaced: ToolResultReplacementRecord[]
}> {
  if (results.length === 0) {
    return { results, newlyReplaced: [] }
  }

  const replacementMap = new Map<string, string>()
  const freshCandidates: ReplacementCandidate[] = []
  let visibleSize = 0

  for (const result of results) {
    const content = normalizeToolResultContent(result.content)
    const previousReplacement = state.replacements.get(result.toolUseId)
    if (previousReplacement !== undefined) {
      replacementMap.set(result.toolUseId, previousReplacement)
      visibleSize += previousReplacement.length
      continue
    }

    if (state.seenIds.has(result.toolUseId)) {
      visibleSize += content.length
      continue
    }

    if (content.trim().length === 0) {
      state.seenIds.add(result.toolUseId)
      continue
    }

    if (isAlreadyPersistedOutput(content)) {
      state.seenIds.add(result.toolUseId)
      state.replacements.set(result.toolUseId, content)
      replacementMap.set(result.toolUseId, content)
      visibleSize += content.length
      continue
    }

    visibleSize += content.length
    freshCandidates.push({
      toolUseId: result.toolUseId,
      content,
      size: content.length,
    })
  }

  const newlyReplaced: ToolResultReplacementRecord[] = []
  const sortedFreshCandidates = [...freshCandidates].sort((a, b) => {
    const sizeDelta = b.size - a.size
    return sizeDelta !== 0 ? sizeDelta : a.toolUseId.localeCompare(b.toolUseId)
  })

  for (const candidate of sortedFreshCandidates) {
    if (visibleSize <= limit) break

    const persisted = await persistToolResult(candidate.content, candidate.toolUseId)
    state.seenIds.add(candidate.toolUseId)
    if (!persisted) {
      continue
    }

    const replacement = buildPersistedToolResultMessage(persisted)
    replacementMap.set(candidate.toolUseId, replacement)
    state.replacements.set(candidate.toolUseId, replacement)
    visibleSize = visibleSize - candidate.size + replacement.length
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement,
    })
  }

  for (const candidate of freshCandidates) {
    state.seenIds.add(candidate.toolUseId)
  }

  if (replacementMap.size === 0) {
    return { results, newlyReplaced }
  }

  return {
    results: results.map(result => {
      const replacement = replacementMap.get(result.toolUseId)
      return replacement === undefined
        ? result
        : { ...result, content: replacement }
    }),
    newlyReplaced,
  }
}
