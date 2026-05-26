import type { ChatMessage, CompressionResult } from '../types.js'
import type { ModelAdapter } from '../types.js'
import { computeContextStats } from '../utils/token-estimator.js'
import { getModelContextWindow } from '../utils/model-context.js'
import { compactConversation } from './compact.js'
import { THRESHOLDS, LIMITS } from './constants.js'

type AutoCompactState = {
  consecutiveFailures: number
  disabled: boolean
}

const state: AutoCompactState = {
  consecutiveFailures: 0,
  disabled: false,
}

// 仅在 CODE_LITE_DEBUG_AUTOCOMPACT=1 时输出自动压缩调试日志
// Log auto-compact debug messages only when CODE_LITE_DEBUG_AUTOCOMPACT=1
function debugAutoCompact(message: string): void {
  if (process.env.CODE_LITE_DEBUG_AUTOCOMPACT === '1') {
    console.error(`[auto-compact] ${message}`)
  }
}

// 重置自动压缩状态：清零连续失败次数，重新启用自动压缩
// Reset auto-compact state: clear consecutive failures and re-enable auto-compaction
export function resetAutoCompactState(): void {
  state.consecutiveFailures = 0
  state.disabled = false
}

// 返回当前自动压缩状态的只读副本
// Return a read-only copy of the current auto-compact state
export function getAutoCompactState(): Readonly<AutoCompactState> {
  return { ...state }
}

// 判断当前上下文利用率是否超过自动压缩阈值
// Check whether current context utilization exceeds the auto-compact threshold
export function shouldAutoCompact(messages: ChatMessage[], model: string): boolean {
  const stats = computeContextStats(messages, model)
  const shouldCompact = stats.utilization >= THRESHOLDS.AUTOCOMPACT_UTILIZATION
  debugAutoCompact(
    `source=${stats.accounting.source} total=${stats.accounting.totalTokens} ` +
      `provider=${stats.accounting.providerUsageTokens} estimate=${stats.accounting.estimatedTokens} ` +
      `utilization=${stats.utilization.toFixed(3)} threshold=${THRESHOLDS.AUTOCOMPACT_UTILIZATION} ` +
      `should=${shouldCompact}`,
  )
  return shouldCompact
}

// 自动压缩入口：检查阈值后执行压缩，连续失败过多则自动禁用
// Auto-compact entry: check threshold then compact; auto-disable after too many consecutive failures
export async function autoCompact(
  messages: ChatMessage[],
  model: string,
  modelAdapter: ModelAdapter,
): Promise<CompressionResult | null> {
  if (state.disabled) {
    return null
  }

  const window = getModelContextWindow(model)
  if (window.effectiveInput < LIMITS.MIN_EFFECTIVE_INPUT_FOR_AUTOCOMPACT) {
    return null
  }

  if (!shouldAutoCompact(messages, model)) {
    return null
  }

  try {
    const result = await compactConversation(messages, modelAdapter)
    if (result) {
      state.consecutiveFailures = 0
      return result
    }

    state.consecutiveFailures++
    if (state.consecutiveFailures >= LIMITS.MAX_AUTOCOMPACT_FAILURES) {
      state.disabled = true
    }
    return null
  } catch {
    state.consecutiveFailures++
    if (state.consecutiveFailures >= LIMITS.MAX_AUTOCOMPACT_FAILURES) {
      state.disabled = true
    }
    return null
  }
}
