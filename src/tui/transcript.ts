import process from 'node:process'
import { charDisplayWidth, wrapPanelBodyLine } from './chrome.js'
import { renderMarkdownish } from './markdown.js'
import type { TranscriptEntry } from './types.js'

const RESET = '[0m'
const DIM = '[2m'
const CYAN = '[36m'
const GREEN = '[32m'
const YELLOW = '[33m'
const RED = '[31m'
const MAGENTA = '[35m'
const BOLD = '[1m'
const BLUE = '[34m'
const REVERSE = '[7m'

export type TranscriptSelection = {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}

// 去除字符串中的 ANSI 转义序列
// Strip ANSI escape sequences from the given string
function stripAnsi(str: string): string {
  return str.replace(/\[[\d;]*[A-Za-z]/g, '')
}

// 按显示列范围截取字符串片段（基于字符显示宽度）
// Slice a substring by display column range (based on character display width)
function sliceByDisplayColumns(input: string, startCol: number, endCol: number): string {
  if (startCol >= endCol) return ''

  let result = ''
  let col = 0
  for (const char of input) {
    const width = charDisplayWidth(char)
    const nextCol = col + width
    if (nextCol <= startCol) {
      col = nextCol
      continue
    }
    if (col >= endCol) {
      break
    }
    result += char
    col = nextCol
  }
  return result
}

// 对行中指定列范围进行反向视频高亮（用于文本选择）
// Apply reverse-video highlighting to a column range within a line (used for text selection)
function highlightRange(line: string, startCol: number, endCol: number): string {
  if (startCol >= endCol) return line

  let result = ''
  let visibleCol = 0
  let i = 0
  let highlighted = false

  while (i < line.length) {
    if (line[i] === '') {
      const escapeStart = i
      i++
      if (i < line.length && line[i] === '[') {
        i++
        while (i < line.length && (line[i] < '@' || line[i] > '~')) {
          i++
        }
        i++
      }
      const seq = line.slice(escapeStart, i)
      result += seq
      if (seq === '[0m' && highlighted) {
        result += REVERSE
      }
      continue
    }

    const char = line[i]
    const width = charDisplayWidth(char)

    if (!highlighted && visibleCol >= startCol) {
      result += REVERSE
      highlighted = true
    }

    if (!highlighted && visibleCol < startCol && visibleCol + width > startCol) {
      result += REVERSE
      highlighted = true
    }

    if (highlighted && visibleCol >= endCol) {
      result += RESET
      highlighted = false
    }

    result += char
    visibleCol += width
    i++

    if (highlighted && visibleCol >= endCol) {
      result += RESET
      highlighted = false
    }
  }

  if (highlighted) {
    result += RESET
  }

  return result
}

// 将多行文本块整体缩进，在每行前添加指定前缀
// Indent a multi-line text block by adding a prefix before each line
function indentBlock(input: string, prefix = '  '): string {
  return input
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n')
}

// 工具输出预览：根据工具类型限制显示的行数和字符数，超出部分截断提示
// Preview a tool's output: limit displayed lines and characters based on tool type, show truncation notice if exceeded
function previewToolBody(toolName: string, body: string): string {
  const maxChars = toolName === 'read_file' ? 1000 : 1800
  const maxLines = toolName === 'read_file' ? 20 : 36
  const lines = body.split('\n')
  const limitedLines = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  let limited = limitedLines.join('\n')

  if (limited.length > maxChars) {
    limited = `${limited.slice(0, maxChars)}...`
  }

  if (limited !== body) {
    return `${limited}\n${DIM}... output truncated in transcript${RESET}`
  }

  return limited
}

// 渲染单条对话记录：用户消息、助手回复、进度更新或工具调用结果
// Render a single transcript entry: user message, assistant reply, progress update, or tool call result
function renderTranscriptEntry(entry: TranscriptEntry): string {
  if (entry.kind === 'user') {
    return `${CYAN}${BOLD}you${RESET}\n${indentBlock(entry.body)}`
  }

  if (entry.kind === 'assistant') {
    return `${GREEN}${BOLD}assistant${RESET}\n${indentBlock(
      renderMarkdownish(entry.body),
    )}`
  }

  if (entry.kind === 'progress') {
    return `${YELLOW}${BOLD}progress${RESET}\n${indentBlock(
      renderMarkdownish(entry.body),
    )}`
  }

  const status =
    entry.status === 'running'
      ? `${YELLOW}running${RESET}`
      : entry.status === 'success'
        ? `${GREEN}ok${RESET}`
        : `${RED}err${RESET}`

  const body =
    entry.status === 'running'
      ? entry.body
      : entry.collapsed
        ? `${DIM}${entry.collapsedSummary ?? 'output collapsed'}${RESET}`
        : entry.collapsePhase
          ? `${DIM}collapsing${'.'.repeat(entry.collapsePhase)}${RESET}`
          : previewToolBody(entry.toolName, renderMarkdownish(entry.body))

  return `${MAGENTA}${BOLD}tool${RESET} ${entry.toolName} ${status}\n${indentBlock(body)}`
}

// 获取对话面板宽度（取终端列数和 60 之间的较大值）
// Get the transcript panel width (max of terminal columns and 60)
function getTranscriptPanelWidth(): number {
  return Math.max(60, process.stdout.columns ?? 100)
}

// 计算对话窗口的可视行数（默认基于终端行数，也可手动指定最小值）
// Calculate the visible line count for the transcript window (defaults to terminal rows, with a manual minimum override)
export function getTranscriptWindowSize(windowSize?: number): number {
  if (windowSize !== undefined) {
    return Math.max(4, windowSize)
  }
  const rows = process.stdout.rows ?? 40
  return Math.max(8, rows - 15)
}

// 将对话条目列表渲染为已换行的文本行数组（含分隔符和面板宽度折行）
// Render a list of transcript entries into wrapped text lines (with separators and panel-width wrapping)
export function renderTranscriptLines(entries: TranscriptEntry[]): string[] {
  const rendered = entries.map(renderTranscriptEntry)
  const separator = `${BLUE}${DIM}·${RESET}`
  const logicalLines: string[] = []

  rendered.forEach((block, index) => {
    if (index > 0) {
      logicalLines.push('')
      logicalLines.push(separator)
      logicalLines.push('')
    }

    logicalLines.push(...block.split('\n'))
  })

  const panelWidth = getTranscriptPanelWidth()
  return logicalLines.flatMap(line => wrapPanelBodyLine(line, panelWidth))
}

// 计算对话区域的最大滚动偏移量（总行数减去窗口大小）
// Calculate the maximum scroll offset for the transcript area (total lines minus window size)
export function getTranscriptMaxScrollOffset(
  entries: TranscriptEntry[],
  windowSize?: number,
): number {
  if (entries.length === 0) return 0
  const lines = renderTranscriptLines(entries)
  return Math.max(0, lines.length - getTranscriptWindowSize(windowSize))
}

// 渲染对话区域的完整视图：根据滚动偏移裁剪可见行，支持文本选择高亮
// Render the full transcript view: clip visible lines by scroll offset, with optional text selection highlighting
export function renderTranscript(
  entries: TranscriptEntry[],
  scrollOffset: number,
  windowSize?: number,
  selection?: TranscriptSelection,
): string {
  if (entries.length === 0) {
    return ''
  }

  let lines = renderTranscriptLines(entries)
  const pageSize = getTranscriptWindowSize(windowSize)
  const maxOffset = Math.max(0, lines.length - pageSize)
  const offset = Math.max(0, Math.min(scrollOffset, maxOffset))
  const end = lines.length - offset
  const start = Math.max(0, end - pageSize)

  if (selection) {
    lines = lines.map((line, index) => {
      if (index < selection.startLine || index > selection.endLine) {
        return line
      }
      if (index === selection.startLine && index === selection.endLine) {
        return highlightRange(line, selection.startCol, selection.endCol)
      }
      if (index === selection.startLine) {
        return highlightRange(line, selection.startCol, Infinity)
      }
      if (index === selection.endLine) {
        return highlightRange(line, 0, selection.endCol)
      }
      return highlightRange(line, 0, Infinity)
    })
  }

  const body = lines.slice(start, end).join('\n')

  if (offset === 0) {
    return body
  }

  return `${body}\n\n${DIM}scroll offset: ${offset}${RESET}`
}

// 从对话条目中提取用户在屏幕上选中的文本（基于行列范围，去除 ANSI 序列）
// Extract user-selected text from transcript entries (based on line/column range, stripping ANSI sequences)
export function extractSelectedText(
  entries: TranscriptEntry[],
  selection: TranscriptSelection,
): string {
  const lines = renderTranscriptLines(entries)
  const { startLine, startCol, endLine, endCol } = selection

  const result: string[] = []
  for (let i = startLine; i <= endLine && i < lines.length; i++) {
    const plainLine = stripAnsi(lines[i])
    if (i === startLine && i === endLine) {
      result.push(sliceByDisplayColumns(plainLine, startCol, endCol))
    } else if (i === startLine) {
      result.push(sliceByDisplayColumns(plainLine, startCol, Infinity))
    } else if (i === endLine) {
      result.push(sliceByDisplayColumns(plainLine, 0, endCol))
    } else {
      result.push(plainLine)
    }
  }
  return result.join('\n')
}
