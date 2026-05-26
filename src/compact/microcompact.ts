import type { ChatMessage } from '../types.js'
import { COMPACTABLE_TOOLS } from '../utils/context.js'
import { computeContextStats, CLEAR_MARKER } from '../utils/token-estimator.js'
import { THRESHOLDS, RETENTION } from './constants.js'

// 轻量级内联压缩：将较旧的可压缩工具结果替换为清除标记以节省 token
// Lightweight inline compaction: replace older compactable tool results with a clear marker to save tokens
export function microcompact(
  messages: ChatMessage[],
  model: string,
): ChatMessage[] {
  const stats = computeContextStats(messages, model)
  if (stats.utilization < THRESHOLDS.MICROCOMPACT_UTILIZATION) {
    return messages
  }

  const toolResultIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'tool_result' && COMPACTABLE_TOOLS.has(msg.toolName)) {
      toolResultIndices.push(i)
    }
  }

  if (toolResultIndices.length <= RETENTION.KEEP_RECENT_TOOL_RESULTS) {
    return messages
  }

  const keepFrom = toolResultIndices.length - RETENTION.KEEP_RECENT_TOOL_RESULTS
  const indicesToClear = new Set(toolResultIndices.slice(0, keepFrom))

  let changed = false
  const result: ChatMessage[] = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (indicesToClear.has(i) && msg.role === 'tool_result') {
      if (msg.content !== CLEAR_MARKER) {
        changed = true
        result.push({
          ...msg,
          content: CLEAR_MARKER,
        })
      } else {
        result.push(msg)
      }
    } else {
      result.push(msg)
    }
  }

  return changed ? result : messages
}
