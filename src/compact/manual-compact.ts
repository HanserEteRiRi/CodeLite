import type { ChatMessage, CompressionResult } from '../types.js'
import type { ModelAdapter } from '../types.js'
import { compactConversation } from './compact.js'
import { resetAutoCompactState } from './auto-compact.js'

// 手动压缩入口：执行压缩后重置自动压缩失败状态
// Manual compact entry: perform compaction then reset auto-compact failure state
export async function manualCompact(
  messages: ChatMessage[],
  modelAdapter: ModelAdapter,
): Promise<CompressionResult | null> {
  const result = await compactConversation(messages, modelAdapter)
  if (result) {
    resetAutoCompactState()
  }
  return result
}
