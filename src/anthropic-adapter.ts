import type { ToolRegistry } from './tool.js'
import type {
  ChatMessage,
  ModelAdapter,
  ProviderThinkingBlock,
  ProviderUsage,
  StepDiagnostics,
  ToolCall,
} from './types.js'
import type { RuntimeConfig } from './config.js'
import { resolveMaxOutputTokens } from './utils/context.js'
import { buildAnthropicSnipBoundaryText } from './compact/snipCompact.js'

const DEFAULT_MAX_RETRIES = 4
const BASE_RETRY_DELAY_MS = 500
const MAX_RETRY_DELAY_MS = 8_000

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: string; [key: string]: unknown }

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

type AnthropicUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// 异步延时工具，返回在指定毫秒后 resolve 的 Promise
// Async delay utility that returns a Promise resolving after the specified milliseconds
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

// 从环境变量读取最大重试次数，未设置时使用默认值 4
// Reads the max retry count from the environment variable, falling back to the default of 4
function getRetryLimit(): number {
  const value = Number(process.env.CODE_LITE_MAX_RETRIES)
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_MAX_RETRIES
  }
  return Math.floor(value)
}

// 判断 HTTP 状态码是否应当触发重试（429 或 5xx）
// Determines whether an HTTP status code should trigger a retry (429 or 5xx)
function shouldRetryStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

// 解析 Retry-After 响应头，返回等待毫秒数；支持秒数和 HTTP 日期格式
// Parses the Retry-After response header and returns the wait time in milliseconds; supports seconds and HTTP-date formats
function parseRetryAfterMs(retryAfter: string | null): number | null {
  if (!retryAfter) return null
  const asSeconds = Number(retryAfter)
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000)
  }

  const at = Date.parse(retryAfter)
  if (!Number.isFinite(at)) {
    return null
  }
  return Math.max(0, at - Date.now())
}

// 计算重试延迟：优先使用服务器指定的 Retry-After，否则使用带抖动的指数退避
// Computes the retry delay: prefers the server-specified Retry-After, otherwise uses exponential backoff with jitter
function getRetryDelayMs(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs !== null) {
    return retryAfterMs
  }
  const base = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)),
    MAX_RETRY_DELAY_MS,
  )
  const jitter = Math.random() * 0.25 * base
  return Math.floor(base + jitter)
}

// 读取 HTTP 响应体并尝试解析为 JSON，解析失败时包装为 error 对象
// Reads the HTTP response body and attempts JSON parsing; wraps the raw text in an error object on parse failure
async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) {
    return {}
  }
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text.trim() } }
  }
}

// 从 API 响应体中提取人类可读的错误信息，覆盖多种错误格式
// Extracts a human-readable error message from the API response body, covering multiple error shapes
function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'string' && data.trim()) {
    return data.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'object' &&
    data.error !== null &&
    'message' in data.error &&
    typeof data.error.message === 'string' &&
    data.error.message.trim()
  ) {
    return data.error.message.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof data.error === 'string' &&
    data.error.trim()
  ) {
    return data.error.trim()
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim()
  ) {
    return data.message.trim()
  }

  return `Model request failed: ${status}`
}

// 类型守卫：判断 Anthropic 内容块是否为文本类型
// Type guard: checks whether an Anthropic content block is a text block
function isTextBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'text'
}> {
  return block.type === 'text' && typeof block.text === 'string'
}

// 类型守卫：判断 Anthropic 内容块是否为工具调用类型
// Type guard: checks whether an Anthropic content block is a tool-use block
function isToolUseBlock(block: AnthropicContentBlock): block is Extract<AnthropicContentBlock, {
  type: 'tool_use'
}> {
  return (
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    typeof block.name === 'string'
  )
}

// 类型守卫：判断内容块是否为 thinking 或 redacted_thinking 类型
// Type guard: checks whether a content block is a thinking or redacted_thinking block
function isThinkingBlock(block: AnthropicContentBlock): block is ProviderThinkingBlock {
  return block.type === 'thinking' || block.type === 'redacted_thinking'
}

// 解析助手文本中的 <final> / <progress> 标记，提取实际内容和消息类型
// Parses <final> / <progress> markers from assistant text, extracting the actual content and message kind
function parseAssistantText(content: string): {
  content: string
  kind?: 'final' | 'progress'
} {
  const trimmed = content.trim()
  if (!trimmed) {
    return { content: '' }
  }

  const markers: Array<{
    prefix: string
    kind: 'final' | 'progress'
  }> = [
    { prefix: '<final>', kind: 'final' },
    { prefix: '[FINAL]', kind: 'final' },
    { prefix: '<progress>', kind: 'progress' },
    { prefix: '[PROGRESS]', kind: 'progress' },
  ]

  for (const marker of markers) {
    if (trimmed.startsWith(marker.prefix)) {
      const rawContent = trimmed.slice(marker.prefix.length).trim()
      const closingTag =
        marker.kind === 'progress'
          ? /<\/progress>/gi
          : /<\/final>/gi
      return {
        content: rawContent.replace(closingTag, '').trim(),
        kind: marker.kind,
      }
    }
  }

  return { content: trimmed }
}

// 将普通字符串包装为 Anthropic text 内容块
// Wraps a plain string into an Anthropic text content block
function toTextBlock(text: string): AnthropicContentBlock {
  return { type: 'text', text }
}

// 将 Anthropic 用量数据标准化为统一的 ProviderUsage 格式，合并输入/缓存 token
// Normalizes Anthropic usage data into the unified ProviderUsage format, merging input and cache tokens
function normalizeAnthropicUsage(usage: AnthropicUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  const outputTokens = usage.output_tokens ?? 0
  const totalTokens = inputTokens + outputTokens
  if (totalTokens <= 0) return undefined
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    source: 'anthropic',
  }
}

// 将助手消息转换为 Anthropic 格式文本；assistant_progress 角色会被包裹在 <progress> 标签中
// Converts an assistant message to Anthropic-format text; assistant_progress roles are wrapped in <progress> tags
function toAssistantText(message: Extract<ChatMessage, {
  role: 'assistant' | 'assistant_progress'
}>): string {
  if (message.role === 'assistant_progress') {
    return `<progress>\n${message.content}\n</progress>`
  }

  return message.content
}

// 向 Anthropic 消息数组追加内容块，自动合并相邻同角色消息
// Appends a content block to the Anthropic message array, automatically merging adjacent messages with the same role
function pushAnthropicMessage(
  messages: AnthropicMessage[],
  role: 'user' | 'assistant',
  block: AnthropicContentBlock,
): void {
  const last = messages.at(-1)
  if (last?.role === role) {
    last.content.push(block)
    return
  }

  messages.push({ role, content: [block] })
}

// 将 CodeLite 的 ChatMessage 数组转换为 Anthropic Messages API 所需的 system + messages 格式
// Converts an array of CodeLite ChatMessages into the system + messages format required by the Anthropic Messages API
function toAnthropicMessages(messages: ChatMessage[]): {
  system: string
  messages: AnthropicMessage[]
} {
  const system = messages
    .filter(message => message.role === 'system')
    .map(message => message.content)
    .join('\n\n')

  const converted: AnthropicMessage[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      pushAnthropicMessage(converted, 'user', toTextBlock(message.content))
      continue
    }

    if (message.role === 'assistant_thinking') {
      for (const block of message.blocks) {
        pushAnthropicMessage(converted, 'assistant', block)
      }
      continue
    }

    if (message.role === 'assistant' || message.role === 'assistant_progress') {
      pushAnthropicMessage(
        converted,
        'assistant',
        toTextBlock(toAssistantText(message)),
      )
      continue
    }

    if (message.role === 'assistant_tool_call') {
      pushAnthropicMessage(converted, 'assistant', {
        type: 'tool_use',
        id: message.toolUseId,
        name: message.toolName,
        input: message.input,
      })
      continue
    }

    if (message.role === 'context_summary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        `[Context Summary from earlier conversation]\n${message.content}`,
      ))
      continue
    }

    if (message.role === 'snip_boundary') {
      pushAnthropicMessage(converted, 'user', toTextBlock(
        buildAnthropicSnipBoundaryText(),
      ))
      continue
    }

    pushAnthropicMessage(converted, 'user', {
      type: 'tool_result',
      tool_use_id: message.toolUseId,
      content: message.content,
      is_error: message.isError,
    })
  }

  return { system, messages: converted }
}

export class AnthropicModelAdapter implements ModelAdapter {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly getRuntimeConfig: () => Promise<RuntimeConfig>,
  ) {}

  // 执行一次模型调用：转换消息格式、发送 HTTP 请求（含重试），解析响应并返回 AgentStep
  // Performs a single model call: converts message format, sends HTTP request (with retries), parses the response, and returns an AgentStep
  async next(messages: ChatMessage[]) {
    const runtime = await this.getRuntimeConfig()
    const payload = toAnthropicMessages(messages)
    const url = `${runtime.baseUrl.replace(/\/$/, '')}/v1/messages`
    const maxOutputTokens = resolveMaxOutputTokens(
      runtime.model,
      runtime.maxOutputTokens,
    )

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }

    if (runtime.authToken) {
      headers.Authorization = `Bearer ${runtime.authToken}`
    } else if (runtime.apiKey) {
      headers['x-api-key'] = runtime.apiKey
    }

    const requestBody = {
      model: runtime.model,
      system: payload.system,
      messages: payload.messages,
      tools: this.tools.list().map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      max_tokens: maxOutputTokens,
    }

    const maxRetries = getRetryLimit()
    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      })
      if (response.ok) {
        break
      }
      if (!shouldRetryStatus(response.status) || attempt >= maxRetries) {
        break
      }
      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      await sleep(getRetryDelayMs(attempt + 1, retryAfterMs))
    }

    if (!response) {
      throw new Error('Model request failed before receiving a response')
    }

    const data = (await readJsonBody(response)) as {
      stop_reason?: string
      content?: AnthropicContentBlock[]
      usage?: AnthropicUsage
      error?: { message?: string }
    }

    if (!response.ok) {
      throw new Error(extractErrorMessage(data, response.status))
    }

    const toolCalls: ToolCall[] = []
    const textParts: string[] = []
    const thinkingBlocks: ProviderThinkingBlock[] = []
    const blockTypes: string[] = []
    const ignoredBlockTypes = new Set<string>()

    for (const block of data.content ?? []) {
      blockTypes.push(block.type)

      if (isTextBlock(block)) {
        textParts.push(block.text)
        continue
      }

      if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          input: block.input,
        })
        continue
      }

      if (isThinkingBlock(block)) {
        thinkingBlocks.push(block)
        continue
      }

      ignoredBlockTypes.add(block.type)
    }

    const parsedText = parseAssistantText(textParts.join('\n').trim())
    const diagnostics: StepDiagnostics = {
      stopReason: data.stop_reason,
      blockTypes,
      ignoredBlockTypes: [...ignoredBlockTypes],
    }
    const usage = normalizeAnthropicUsage(data.usage)

    if (toolCalls.length > 0) {
      return {
        type: 'tool_calls' as const,
        calls: toolCalls,
        content: parsedText.content || undefined,
        contentKind:
          parsedText.kind === 'progress'
            ? ('progress' as const)
            : undefined,
        thinkingBlocks,
        diagnostics,
        usage,
      }
    }

    return {
      type: 'assistant' as const,
      content: parsedText.content,
      kind: parsedText.kind,
      thinkingBlocks,
      diagnostics,
      usage,
    }
  }
}
