import type { ChatMessage, ProviderUsage } from '../types.js'
import { getModelContextWindow } from './model-context.js'

export type TokenAccountingSource =
  | 'provider_usage'
  | 'provider_usage_plus_estimate'
  | 'estimate_only'

export type TokenAccountingResult = {
  totalTokens: number
  providerUsageTokens: number
  estimatedTokens: number
  source: TokenAccountingSource
  isExact: boolean
  usageBoundary?: {
    messageIndex: number
    messageId?: string
  }
  stale?: boolean
  reason?: string
}

export type ContextStats = {
  estimatedTokens: number
  totalTokens: number
  providerUsageTokens: number
  contextWindow: number
  effectiveInput: number
  utilization: number
  warningLevel: 'normal' | 'warning' | 'critical' | 'blocked'
  accounting: TokenAccountingResult
}

const CHARS_PER_TOKEN: Record<string, number> = {
  system: 3.5,
  user: 3.0,
  assistant_thinking: 3.0,
  assistant: 3.5,
  assistant_progress: 3.5,
  assistant_tool_call: 2.5,
  tool_result: 2.0,
  context_summary: 3.5,
  snip_boundary: 3.5,
}

const CLEAR_MARKER = '[Output cleared for context space]'

// 根据消息角色计算其内容的字符长度
// Compute the character length of a message's content based on its role
function messageContentLength(message: ChatMessage): number {
  switch (message.role) {
    case 'system':
    case 'user':
    case 'assistant':
    case 'assistant_progress':
      return message.content.length
    case 'assistant_thinking':
      try {
        return JSON.stringify(message.blocks).length
      } catch {
        return 0
      }
    case 'assistant_tool_call':
      try {
        return JSON.stringify(message.input).length
      } catch {
        return 0
      }
    case 'tool_result':
      return message.content.length
    case 'context_summary':
      return message.content.length
    case 'snip_boundary':
      return message.content.length
    default:
      return 0
  }
}

// 估算单条消息所占用的 token 数量
// Estimate the number of tokens consumed by a single message
export function estimateMessageTokens(message: ChatMessage): number {
  const ratio = CHARS_PER_TOKEN[message.role] ?? 3.0
  const length = messageContentLength(message)
  return Math.ceil(length / ratio)
}

// 估算消息数组的总 token 数量
// Estimate the total token count for an array of messages
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += estimateMessageTokens(message)
  }
  return total
}

// 从助手消息中提取有效的 provider 用量统计（排除已标记为过期的）
// Extract valid provider usage stats from an assistant message (excluding stale)
function messageProviderUsage(message: ChatMessage): ProviderUsage | undefined {
  if (
    (message.role === 'assistant' ||
      message.role === 'assistant_progress' ||
      message.role === 'assistant_tool_call') &&
    message.providerUsage &&
    !message.usageStale
  ) {
    return message.providerUsage
  }
  return undefined
}

// 查找消息数组中第一个过期用量标记的原因
// Find the stale-usage reason from the first message with stale provider usage
function staleUsageReason(messages: ChatMessage[]): string | undefined {
  for (const message of messages) {
    if (
      (message.role === 'assistant' ||
        message.role === 'assistant_progress' ||
        message.role === 'assistant_tool_call') &&
      message.providerUsage &&
      message.usageStale
    ) {
      return message.usageStaleReason ?? 'provider usage was marked stale'
    }
  }
  return undefined
}

// 获取消息的边界标识符，用于定位用量统计的截止位置
// Get a message's boundary identifier used to locate the usage cutoff point
function messageBoundaryId(message: ChatMessage): string | undefined {
  if (message.role === 'assistant_tool_call') return message.toolUseId
  return undefined
}

// 混合计算 token 总量：使用最新的 provider 用量为基准，追加估算后续消息
// Compute total tokens by combining the latest provider usage with estimates for tail messages
export function tokenCountWithEstimation(messages: ChatMessage[]): TokenAccountingResult {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messageProviderUsage(messages[i])
    if (!usage) continue

    const tailMessages = messages.slice(i + 1)
    const estimatedTokens = estimateMessagesTokens(tailMessages)
    return {
      totalTokens: usage.totalTokens + estimatedTokens,
      providerUsageTokens: usage.totalTokens,
      estimatedTokens,
      source: estimatedTokens > 0 ? 'provider_usage_plus_estimate' : 'provider_usage',
      isExact: estimatedTokens === 0,
      usageBoundary: {
        messageIndex: i,
        messageId: messageBoundaryId(messages[i]),
      },
    }
  }

  const reason = staleUsageReason(messages)
  const estimatedTokens = estimateMessagesTokens(messages)
  return {
    totalTokens: estimatedTokens,
    providerUsageTokens: 0,
    estimatedTokens,
    source: 'estimate_only',
    isExact: false,
    stale: Boolean(reason),
    reason: reason ?? 'no provider usage available',
  }
}

// 将消息上的 provider 用量标记为过期（例如在用户编辑消息后）
// Mark the provider usage on a message as stale (e.g. after user edits a message)
export function markProviderUsageStale(
  message: ChatMessage,
  reason: string,
): ChatMessage {
  if (
    (message.role === 'assistant' ||
      message.role === 'assistant_progress' ||
      message.role === 'assistant_tool_call') &&
    message.providerUsage
  ) {
    return {
      ...message,
      usageStale: true,
      usageStaleReason: reason,
    }
  }
  return message
}

// 计算完整的上下文统计信息，包括利用率、告警级别和 token 明细
// Compute full context statistics including utilization, warning level, and token breakdown
export function computeContextStats(
  messages: ChatMessage[],
  model: string,
): ContextStats {
  const window = getModelContextWindow(model)
  const accounting = tokenCountWithEstimation(messages)
  const utilization = Math.min(1, accounting.totalTokens / window.effectiveInput)

  let warningLevel: ContextStats['warningLevel']
  if (utilization >= 0.95) {
    warningLevel = 'blocked'
  } else if (utilization >= 0.85) {
    warningLevel = 'critical'
  } else if (utilization >= 0.50) {
    warningLevel = 'warning'
  } else {
    warningLevel = 'normal'
  }

  return {
    estimatedTokens: accounting.estimatedTokens,
    totalTokens: accounting.totalTokens,
    providerUsageTokens: accounting.providerUsageTokens,
    contextWindow: window.contextWindow,
    effectiveInput: window.effectiveInput,
    utilization,
    warningLevel,
    accounting,
  }
}

export { CLEAR_MARKER }
