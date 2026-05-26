import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { readMcpTokensFile } from './config.js'
import type { McpServerConfig } from './config.js'
import type { ToolDefinition, ToolResult } from './tool.js'
import { getErrorCode } from './utils/errors.js'

type JsonRpcMessage = {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

type McpToolDescriptor = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

type McpResourceDescriptor = {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

type McpPromptArgument = {
  name: string
  description?: string
  required?: boolean
}

type McpPromptDescriptor = {
  name: string
  description?: string
  arguments?: McpPromptArgument[]
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export type McpServerSummary = {
  name: string
  command: string
  status: 'connecting' | 'connected' | 'error' | 'disabled'
  toolCount: number
  error?: string
  protocol?: JsonRpcProtocol
  resourceCount?: number
  promptCount?: number
}

type JsonRpcProtocol = 'content-length' | 'newline-json' | 'streamable-http'
const MCP_INITIALIZE_TIMEOUT_MS = 10000
const MCP_INITIALIZE_PROBE_TIMEOUT_MS = 1200
const MCP_PROTOCOL_CACHE_PATH = path.join(
  os.homedir(),
  '.code-lite',
  'mcp-protocol-cache.json',
)

type ProtocolCache = Record<string, JsonRpcProtocol>

// 格式化子进程启动错误，根据错误码提供友好的诊断信息
// Format a child-process startup error with friendly diagnostic info based on the error code
function formatChildProcessError(
  serverName: string,
  command: string,
  stderrLines: string[],
  error: unknown,
): Error {
  const code = getErrorCode(error) ?? undefined
  const detail =
    error instanceof Error ? error.message : String(error)

  const lines = [`Failed to start MCP server "${serverName}" using command "${command}".`]

  if (code === 'ENOENT') {
    lines.push(
      `Command not found: ${command}. Install it first and ensure it is available in PATH.`,
    )
  } else if (detail) {
    lines.push(detail)
  }

  if (detail && code === 'ENOENT') {
    lines.push(`Original error: ${detail}`)
  }

  if (stderrLines.length > 0) {
    lines.push(stderrLines.join('\n'))
  }

  return new Error(lines.join('\n'))
}

// 判断错误是否由 initialize 请求超时引起
// Check whether an error was caused by an initialize request timeout
function isInitializeTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('request timed out for initialize')
  )
}

// 将工具名称片段净化为安全的标识符（小写字母、数字、下划线、连字符）
// Sanitize a tool name segment into a safe identifier (lowercase letters, digits, underscores, hyphens)
function sanitizeToolSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'tool'
  )
}

// 将输入 schema 规范化为有效的 JSON Schema 对象，无效时返回宽松的默认值
// Normalize an input schema to a valid JSON Schema object; return a permissive default when invalid
function normalizeInputSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    return schema
  }

  return {
    type: 'object',
    additionalProperties: true,
  }
}

// 将 MCP 内容块格式化为可读的文本字符串
// Format an MCP content block into a readable text string
function formatContentBlock(block: unknown): string {
  if (!block || typeof block !== 'object') {
    return JSON.stringify(block, null, 2)
  }

  if ('type' in block && block.type === 'text' && 'text' in block) {
    return String(block.text)
  }

  if ('type' in block && 'resource' in block) {
    return JSON.stringify(block, null, 2)
  }

  return JSON.stringify(block, null, 2)
}

// 将 MCP 工具调用结果格式化为标准的 ToolResult 对象
// Format an MCP tool call result into a standard ToolResult object
function formatToolCallResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: true,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    content?: unknown[]
    structuredContent?: unknown
    isError?: boolean
  }

  const parts: string[] = []

  if (Array.isArray(typedResult.content) && typedResult.content.length > 0) {
    parts.push(typedResult.content.map(formatContentBlock).join('\n\n'))
  }

  if (typedResult.structuredContent !== undefined) {
    parts.push(
      `STRUCTURED_CONTENT:\n${JSON.stringify(typedResult.structuredContent, null, 2)}`,
    )
  }

  if (parts.length === 0) {
    parts.push(JSON.stringify(result, null, 2))
  }

  return {
    ok: !typedResult.isError,
    output: parts.join('\n\n').trim(),
  }
}

// 将 MCP 资源读取结果格式化为标准的 ToolResult 对象
// Format an MCP resource read result into a standard ToolResult object
function formatReadResourceResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    contents?: Array<{
      uri?: string
      mimeType?: string
      text?: string
      blob?: string
    }>
  }

  const contents = typedResult.contents ?? []
  if (contents.length === 0) {
    return {
      ok: true,
      output: 'No resource contents returned.',
    }
  }

  return {
    ok: true,
    output: contents
      .map(item => {
        const headerLines = [`URI: ${item.uri ?? '(unknown)'}`]
        if (item.mimeType) {
          headerLines.push(`MIME: ${item.mimeType}`)
        }
        const header = `${headerLines.join('\n')}\n\n`

        if (typeof item.text === 'string') {
          return `${header}${item.text}`
        }

        if (typeof item.blob === 'string') {
          return `${header}BLOB:\n${item.blob}`
        }

        return `${header}${JSON.stringify(item, null, 2)}`
      })
      .join('\n\n'),
  }
}

// 将 MCP 提示模板结果格式化为标准的 ToolResult 对象
// Format an MCP prompt template result into a standard ToolResult object
function formatPromptResult(result: unknown): ToolResult {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      output: JSON.stringify(result, null, 2),
    }
  }

  const typedResult = result as {
    description?: string
    messages?: Array<{
      role?: string
      content?: unknown
    }>
  }

  const header = typedResult.description
    ? `DESCRIPTION: ${typedResult.description}\n\n`
    : ''
  const body = (typedResult.messages ?? [])
    .map(message => {
      const role = message.role ?? 'unknown'
      if (typeof message.content === 'string') {
        return `[${role}]\n${message.content}`
      }
      if (Array.isArray(message.content)) {
        return `[${role}]\n${message.content
          .map(part => {
            if (typeof part === 'string') return part
            if (part && typeof part === 'object' && 'text' in part) {
              return String(part.text)
            }
            return JSON.stringify(part, null, 2)
          })
          .join('\n')}`
      }
      return `[${role}]\n${JSON.stringify(message.content, null, 2)}`
    })
    .join('\n\n')

  return {
    ok: true,
    output: `${header}${body}`.trim() || JSON.stringify(result, null, 2),
  }
}

// 生成服务器端点的可读摘要（URL 或命令加参数）
// Generate a human-readable summary of the server endpoint (URL or command with args)
function summarizeServerEndpoint(config: McpServerConfig): string {
  const remoteUrl = config.url?.trim()
  if (remoteUrl) return remoteUrl
  const command = config.command?.trim() ?? ''
  const args = config.args?.join(' ') ?? ''
  return `${command} ${args}`.trim()
}

// 将 string|number 值记录转换为纯字符串记录
// Convert a record of string|number values to a pure string record
function toStringRecord(
  values: Record<string, string | number> | undefined,
): Record<string, string> {
  if (!values) return {}
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, String(value)]),
  )
}

// 替换字符串中的环境变量引用（$VAR 或 ${VAR} 格式）
// Interpolate environment variable references in a string ($VAR or ${VAR} syntax)
function interpolateEnv(value: string): string {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, simple, braced) => {
    const key = String(simple ?? braced ?? '').trim()
    if (!key) return ''
    return process.env[key] ?? ''
  })
}

// 解析 HTTP 头部记录，对其值进行环境变量插值
// Resolve an HTTP header record with environment variable interpolation on values
function resolveHeaderRecord(
  values: Record<string, string | number> | undefined,
): Record<string, string> {
  const raw = toStringRecord(values)
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, interpolateEnv(value)]),
  )
}

// 从 HTTP 响应头中提取 OAuth 认证提示信息（WWW-Authenticate）
// Extract OAuth authentication hints from HTTP response headers (WWW-Authenticate)
function extractAuthHint(headers: Headers): string | null {
  const challenges = headers.get('www-authenticate')
  if (!challenges) return null
  const parts: string[] = [challenges]
  const resourceMetadata = /resource_metadata=\"([^\"]+)\"/i.exec(challenges)?.[1]
  const authorizationUri = /authorization_uri=\"([^\"]+)\"/i.exec(challenges)?.[1]
  if (resourceMetadata) {
    parts.push(`resource_metadata=${resourceMetadata}`)
  }
  if (authorizationUri) {
    parts.push(`authorization_uri=${authorizationUri}`)
  }
  return parts.join('\n')
}

type McpClientLike = {
  start(): Promise<void>
  getProtocol(): JsonRpcProtocol | null
  getServerName(): string
  listTools(): Promise<McpToolDescriptor[]>
  listResources(): Promise<McpResourceDescriptor[]>
  readResource(uri: string): Promise<ToolResult>
  listPrompts(): Promise<McpPromptDescriptor[]>
  getPrompt(name: string, args?: Record<string, string>): Promise<ToolResult>
  callTool(name: string, input: unknown): Promise<ToolResult>
  close(): Promise<void>
}

const mcpTokenCache = new Map<string, string>()

// 从令牌文件加载指定 MCP 服务器的 Bearer 令牌，结果会被缓存
// Load the Bearer token for a given MCP server from the tokens file; results are cached
async function loadMcpToken(serverName: string): Promise<string | undefined> {
  if (mcpTokenCache.has(serverName)) {
    return mcpTokenCache.get(serverName)
  }
  const tokens = await readMcpTokensFile()
  const token = tokens[serverName]?.trim()
  if (token) {
    mcpTokenCache.set(serverName, token)
    return token
  }
  return undefined
}

// 从磁盘读取 MCP 协议协商缓存
// Read the MCP protocol negotiation cache from disk
async function readProtocolCache(): Promise<ProtocolCache> {
  try {
    const content = await readFile(MCP_PROTOCOL_CACHE_PATH, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const cache: ProtocolCache = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        value === 'content-length' ||
        value === 'newline-json' ||
        value === 'streamable-http'
      ) {
        cache[key] = value
      }
    }
    return cache
  } catch {
    return {}
  }
}

// 将 MCP 协议协商缓存写入磁盘
// Write the MCP protocol negotiation cache to disk
async function writeProtocolCache(cache: ProtocolCache): Promise<void> {
  await mkdir(path.dirname(MCP_PROTOCOL_CACHE_PATH), { recursive: true })
  await writeFile(MCP_PROTOCOL_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}

class StdioMcpClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private buffer = Buffer.alloc(0)
  private lineBuffer = ''
  private pending = new Map<number, PendingRequest>()
  private stderrLines: string[] = []
  private protocol: JsonRpcProtocol | null = null

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
    private readonly cwd: string,
    private readonly preferredProtocol?: JsonRpcProtocol,
  ) {}

  // 启动 MCP 服务器进程并完成协议协商与初始化握手
  // Start the MCP server process and complete protocol negotiation and initialization handshake
  async start(): Promise<void> {
    if (this.process) {
      return
    }

    const protocols = this.getProtocolCandidates()
    const autoProtocol =
      this.config.protocol === undefined || this.config.protocol === 'auto'
    let lastError: Error | null = null

    for (let index = 0; index < protocols.length; index += 1) {
      const protocol = protocols[index]!
      const useProbeTimeout =
        autoProtocol && !this.preferredProtocol && index === 0
      const timeoutMs =
        useProbeTimeout
          ? MCP_INITIALIZE_PROBE_TIMEOUT_MS
          : MCP_INITIALIZE_TIMEOUT_MS
      try {
        await this.initializeWithProtocol(protocol, timeoutMs)
        return
      } catch (error) {
        // Fast probe can be too short on cold starts: retry the same protocol once
        // with full timeout before falling back to another framing format.
        if (useProbeTimeout && isInitializeTimeoutError(error)) {
          await this.close()
          try {
            await this.initializeWithProtocol(protocol, MCP_INITIALIZE_TIMEOUT_MS)
            return
          } catch (retryError) {
            lastError =
              retryError instanceof Error
                ? retryError
                : new Error(String(retryError))
            await this.close()
            continue
          }
        }
        lastError = error instanceof Error ? error : new Error(String(error))
        await this.close()
      }
    }

    throw lastError ?? new Error(`Failed to connect MCP server "${this.serverName}".`)
  }

  // 返回当前协商确定的 JSON-RPC 协议类型
  // Return the currently negotiated JSON-RPC protocol type
  getProtocol(): JsonRpcProtocol | null {
    return this.protocol
  }

  // 返回当前 MCP 服务器的名称
  // Return the name of this MCP server
  getServerName(): string {
    return this.serverName
  }

  // 使用指定协议启动进程并完成 MCP 初始化握手
  // Spawn a process with the given protocol and complete the MCP initialization handshake
  private async initializeWithProtocol(
    protocol: JsonRpcProtocol,
    timeoutMs: number,
  ): Promise<void> {
    await this.spawnProcess()
    this.protocol = protocol
    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'code-lite',
          version: '0.1.0',
        },
      },
      timeoutMs,
    )
    this.notify('notifications/initialized', {})
  }

  // 根据配置和首选协议返回要尝试的协议候选列表
  // Return the ordered list of protocol candidates to try based on config and preferred protocol
  private getProtocolCandidates(): JsonRpcProtocol[] {
    if (this.config.protocol === 'content-length') {
      return ['content-length']
    }
    if (this.config.protocol === 'newline-json') {
      return ['newline-json']
    }
    if (this.preferredProtocol === 'newline-json') {
      return ['newline-json', 'content-length']
    }
    return ['content-length', 'newline-json']
  }

  // 启动子进程并设置 stdin/stdout/stderr 管道及事件处理
  // Spawn the child process and wire up stdin/stdout/stderr pipes and event handlers
  private async spawnProcess(): Promise<void> {
    const command = (this.config.command ?? '').trim()
    if (!command) {
      throw new Error(`MCP server "${this.serverName}" has no command configured.`)
    }

    this.buffer = Buffer.alloc(0)
    this.lineBuffer = ''
    this.stderrLines = []
    this.pending.clear()

    const child = spawn(command, this.config.args ?? [], {
      cwd: this.config.cwd ? path.resolve(this.cwd, this.config.cwd) : this.cwd,
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(this.config.env ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
      },
      stdio: 'pipe',
    })

    this.process = child
    const handleProcessError = (error: unknown) => {
      const wrapped = formatChildProcessError(
        this.serverName,
        command,
        this.stderrLines,
        error,
      )

      if (this.process === child) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timeout)
          pending.reject(wrapped)
        }
        this.pending.clear()
        this.process = null
      }
    }

    child.stdout.on('data', chunk => {
      if (this.process !== child) {
        return
      }
      this.handleStdoutChunk(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      if (this.process !== child) {
        return
      }
      this.stderrLines.push(String(chunk).trim())
      this.stderrLines = this.stderrLines.filter(Boolean).slice(-8)
    })
    child.on('error', handleProcessError)
    child.on('exit', code => {
      if (this.process !== child) {
        return
      }
      const error = new Error(
        `MCP server "${this.serverName}" exited with code ${code ?? 'unknown'}${
          this.stderrLines.length > 0
            ? `\n${this.stderrLines.join('\n')}`
            : ''
        }`,
      )
      for (const pending of this.pending.values()) {
        pending.reject(error)
      }
      this.pending.clear()
      this.process = null
    })

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off('error', onInitialError)
        resolve()
      }
      const onInitialError = (error: unknown) => {
        child.off('spawn', onSpawn)
        reject(
          formatChildProcessError(this.serverName, command, this.stderrLines, error),
        )
      }

      child.once('spawn', onSpawn)
      child.once('error', onInitialError)
    })
  }

  // 调用 MCP tools/list 获取服务器提供的工具列表
  // Call MCP tools/list to retrieve the list of tools provided by the server
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolDescriptor[]
    }
    return result.tools ?? []
  }

  // 调用 MCP resources/list 获取服务器发布的资源列表
  // Call MCP resources/list to retrieve the list of resources published by the server
  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request('resources/list', {}, 3000)) as {
      resources?: McpResourceDescriptor[]
    }
    return result.resources ?? []
  }

  // 调用 MCP resources/read 读取指定 URI 的资源内容
  // Call MCP resources/read to read the content of a resource at the given URI
  async readResource(uri: string): Promise<ToolResult> {
    const result = await this.request('resources/read', { uri }, 5000)
    return formatReadResourceResult(result)
  }

  // 调用 MCP prompts/list 获取服务器发布的提示模板列表
  // Call MCP prompts/list to retrieve the list of prompt templates published by the server
  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request('prompts/list', {}, 3000)) as {
      prompts?: McpPromptDescriptor[]
    }
    return result.prompts ?? []
  }

  // 调用 MCP prompts/get 获取并渲染指定名称的提示模板
  // Call MCP prompts/get to fetch and render a prompt template by name
  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<ToolResult> {
    const result = await this.request(
      'prompts/get',
      {
        name,
        arguments: args ?? {},
      },
      5000,
    )
    return formatPromptResult(result)
  }

  // 调用 MCP tools/call 执行指定名称的服务器工具
  // Call MCP tools/call to execute a server tool by name
  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: input ?? {},
    })
    return formatToolCallResult(result)
  }

  // 关闭 MCP 服务器连接：终止子进程并清理所有待处理请求
  // Close the MCP server connection: kill the child process and clear all pending requests
  async close(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(
        new Error(`MCP server "${this.serverName}" closed before completing the request.`),
      )
    }
    this.pending.clear()

    if (!this.process) {
      this.protocol = null
      return
    }

    this.process.kill()
    this.process = null
    this.protocol = null
  }

  // 发送 JSON-RPC 通知（无需响应的单向消息）
  // Send a JSON-RPC notification (one-way message that does not expect a response)
  private notify(method: string, params: unknown): void {
    this.send({
      jsonrpc: '2.0',
      method,
      params,
    })
  }

  // 发送带 ID 的 JSON-RPC 请求并返回 Promise，支持超时
  // Send a JSON-RPC request with an ID and return a Promise with timeout support
  private request(
    method: string,
    params: unknown,
    timeoutMs = 5000,
  ): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `MCP ${this.serverName}: request timed out for ${method}${
              this.stderrLines.length > 0 ? `\n${this.stderrLines.join('\n')}` : ''
            }`,
          ),
        )
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timeout })
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      })
    })
  }

  // 根据当前协议格式将 JSON-RPC 消息写入子进程 stdin
  // Write a JSON-RPC message to the child process stdin in the current protocol format
  private send(message: JsonRpcMessage): void {
    if (!this.process) {
      throw new Error(`MCP server "${this.serverName}" is not running.`)
    }

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    if (this.protocol === 'newline-json') {
      this.process.stdin.write(`${body.toString('utf8')}\n`)
      return
    }

    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
    this.process.stdin.write(Buffer.concat([header, body]))
  }

  // 处理子进程 stdout 数据块：根据协议类型路由到对应的解析器
  // Handle child process stdout data chunks: route to the appropriate parser based on protocol
  private handleStdoutChunk(chunk: Buffer): void {
    if (this.protocol === 'newline-json') {
      this.handleStdoutChunkAsLines(chunk)
      return
    }

    this.buffer = Buffer.concat([this.buffer, chunk])

    while (true) {
      const separatorIndex = this.buffer.indexOf('\r\n\r\n')
      if (separatorIndex === -1) {
        return
      }

      const headerText = this.buffer
        .subarray(0, separatorIndex)
        .toString('utf8')
      const headers = headerText.split('\r\n')
      const contentLengthHeader = headers.find(line =>
        line.toLowerCase().startsWith('content-length:'),
      )
      if (!contentLengthHeader) {
        this.buffer = this.buffer.subarray(separatorIndex + 4)
        continue
      }

      const contentLength = Number(contentLengthHeader.split(':')[1]?.trim() ?? 0)
      const bodyStart = separatorIndex + 4
      const bodyEnd = bodyStart + contentLength

      if (this.buffer.length < bodyEnd) {
        return
      }

      const payload = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
      this.buffer = this.buffer.subarray(bodyEnd)
      this.handleMessage(JSON.parse(payload) as JsonRpcMessage)
    }
  }

  // 以 newline-json 协议格式解析 stdout 数据：按行分割并逐行处理 JSON 消息
  // Parse stdout data in newline-json protocol format: split by lines and process each JSON message
  private handleStdoutChunkAsLines(chunk: Buffer): void {
    this.lineBuffer += chunk.toString('utf8')

    while (true) {
      const newlineIndex = this.lineBuffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }

      const rawLine = this.lineBuffer.slice(0, newlineIndex)
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1)
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      this.handleMessage(JSON.parse(line) as JsonRpcMessage)
    }
  }

  // 处理收到的 JSON-RPC 响应：匹配待处理请求并 resolve/reject
  // Handle an incoming JSON-RPC response: match a pending request and resolve or reject it
  private handleMessage(message: JsonRpcMessage): void {
    if (typeof message.id !== 'number') {
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }

    this.pending.delete(message.id)
    clearTimeout(pending.timeout)

    if (message.error) {
      pending.reject(
        new Error(
          `MCP ${this.serverName}: ${message.error.message}${
            message.error.data ? `\n${JSON.stringify(message.error.data, null, 2)}` : ''
          }`,
        ),
      )
      return
    }

    pending.resolve(message.result)
  }
}

class StreamableHttpMcpClient {
  private nextId = 1
  private bearerToken: string | null = null

  constructor(
    private readonly serverName: string,
    private readonly config: McpServerConfig,
  ) {}

  // 向远程 HTTP 端点发送 MCP 初始化请求并完成握手
  // Send an MCP initialize request to the remote HTTP endpoint and complete the handshake
  async start(): Promise<void> {
    if (!this.config.url?.trim()) {
      throw new Error(`MCP server "${this.serverName}" has no URL configured.`)
    }

    this.bearerToken = (await loadMcpToken(this.serverName)) ?? null

    await this.request(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'code-lite',
          version: '0.1.0',
        },
      },
      MCP_INITIALIZE_TIMEOUT_MS,
    )
    await this.notify('notifications/initialized', {})
  }

  // 返回 streamable-http 协议标识
  // Return the streamable-http protocol identifier
  getProtocol(): JsonRpcProtocol | null {
    return 'streamable-http'
  }

  // 返回当前 MCP 服务器的名称
  // Return the name of this MCP server
  getServerName(): string {
    return this.serverName
  }

  // 调用 MCP tools/list 获取服务器提供的工具列表
  // Call MCP tools/list to retrieve the list of tools provided by the server
  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.request('tools/list', {})) as {
      tools?: McpToolDescriptor[]
    }
    return result.tools ?? []
  }

  // 调用 MCP resources/list 获取服务器发布的资源列表
  // Call MCP resources/list to retrieve the list of resources published by the server
  async listResources(): Promise<McpResourceDescriptor[]> {
    const result = (await this.request('resources/list', {}, 3000)) as {
      resources?: McpResourceDescriptor[]
    }
    return result.resources ?? []
  }

  // 调用 MCP resources/read 读取指定 URI 的资源内容
  // Call MCP resources/read to read the content of a resource at the given URI
  async readResource(uri: string): Promise<ToolResult> {
    const result = await this.request('resources/read', { uri }, 5000)
    return formatReadResourceResult(result)
  }

  // 调用 MCP prompts/list 获取服务器发布的提示模板列表
  // Call MCP prompts/list to retrieve the list of prompt templates published by the server
  async listPrompts(): Promise<McpPromptDescriptor[]> {
    const result = (await this.request('prompts/list', {}, 3000)) as {
      prompts?: McpPromptDescriptor[]
    }
    return result.prompts ?? []
  }

  // 调用 MCP prompts/get 获取并渲染指定名称的提示模板
  // Call MCP prompts/get to fetch and render a prompt template by name
  async getPrompt(name: string, args?: Record<string, string>): Promise<ToolResult> {
    const result = await this.request(
      'prompts/get',
      {
        name,
        arguments: args ?? {},
      },
      5000,
    )
    return formatPromptResult(result)
  }

  // 调用 MCP tools/call 执行指定名称的服务器工具
  // Call MCP tools/call to execute a server tool by name
  async callTool(name: string, input: unknown): Promise<ToolResult> {
    const result = await this.request('tools/call', {
      name,
      arguments: input ?? {},
    })
    return formatToolCallResult(result)
  }

  // Streamable HTTP 客户端的连接关闭操作（无子进程，直接返回）
  // Close the connection for Streamable HTTP client (no child process, returns immediately)
  async close(): Promise<void> {
    return
  }

  // 发送 JSON-RPC 通知到远程 HTTP 端点（忽略响应错误）
  // Send a JSON-RPC notification to the remote HTTP endpoint (ignore response errors)
  private async notify(method: string, params: unknown): Promise<void> {
    try {
      await this.postJsonRpc({ jsonrpc: '2.0', method, params }, 2000)
    } catch {
      // Some servers ignore notifications over plain HTTP response mode.
    }
  }

  // 通过 HTTP POST 发送 JSON-RPC 请求并返回解析后的结果
  // Send a JSON-RPC request via HTTP POST and return the parsed result
  private async request(method: string, params: unknown, timeoutMs = 5000): Promise<unknown> {
    const id = this.nextId++
    const payload = await this.postJsonRpc(
      {
        jsonrpc: '2.0',
        id,
        method,
        params,
      },
      timeoutMs,
    )

    if (!payload || typeof payload !== 'object') {
      throw new Error(`MCP ${this.serverName}: invalid response payload.`)
    }

    const message = payload as JsonRpcMessage
    if (message.error) {
      throw new Error(
        `MCP ${this.serverName}: ${message.error.message}${
          message.error.data ? `\n${JSON.stringify(message.error.data, null, 2)}` : ''
        }`,
      )
    }
    return message.result
  }

  // 通过 HTTP POST 发送 JSON-RPC 负载到远程端点，支持超时和认证
  // POST a JSON-RPC payload to the remote endpoint via HTTP with timeout and authentication support
  private async postJsonRpc(message: JsonRpcMessage, timeoutMs: number): Promise<unknown> {
    const endpoint = this.config.url?.trim()
    if (!endpoint) {
      throw new Error(`MCP server "${this.serverName}" has no URL configured.`)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Align with MCP streamable HTTP content negotiation behavior.
          accept: 'application/json, text/event-stream',
          ...resolveHeaderRecord(this.config.headers),
          ...(this.bearerToken ? { Authorization: `Bearer ${this.bearerToken}` } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      })

      if (!response.ok) {
        const authHint = extractAuthHint(response.headers)
        const bodyText = await response.text().catch(() => '')
        const detail = bodyText.trim().slice(0, 600)
        const lines = [`HTTP ${response.status} ${response.statusText}`]
        if (authHint) {
          lines.push(`AUTH:\n${authHint}`)
        }
        if (detail) {
          lines.push(`BODY:\n${detail}`)
        }
        throw new Error(lines.join('\n'))
      }

      const responseText = await response.text()
      if (!responseText.trim()) {
        return {}
      }
      try {
        return JSON.parse(responseText) as unknown
      } catch {
        throw new Error(
          `MCP ${this.serverName}: expected JSON response but received non-JSON payload.`,
        )
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `MCP ${this.serverName}: request timed out for ${message.method ?? 'notification'}.`,
        )
      }
      throw error instanceof Error
        ? error
        : new Error(`MCP ${this.serverName}: ${String(error)}`)
    } finally {
      clearTimeout(timeout)
    }
  }
}

// 根据 MCP 服务器配置创建包装后的工具列表，启动所有已启用的服务器并注册其工具
// Create wrapped tool definitions from MCP server configs, start all enabled servers and register their tools
export async function createMcpBackedTools(args: {
  cwd: string
  mcpServers: Record<string, McpServerConfig>
}): Promise<{
  tools: ToolDefinition<unknown>[]
  servers: McpServerSummary[]
  dispose: () => Promise<void>
}> {
  const protocolCache = await readProtocolCache()
  let protocolCacheDirty = false
  const clients: McpClientLike[] = []
  const clientsByServer = new Map<string, McpClientLike>()
  const tools: ToolDefinition<unknown>[] = []
  const servers: McpServerSummary[] = []
  let hasPublishedResources = false
  let hasPublishedPrompts = false

  for (const [serverName, config] of Object.entries(args.mcpServers)) {
    const endpointKey = `${serverName}::${summarizeServerEndpoint(config)}`
    if (config.enabled === false) {
      servers.push({
        name: serverName,
        command: summarizeServerEndpoint(config),
        status: 'disabled',
        toolCount: 0,
        protocol:
          config.protocol === 'auto' || config.protocol === undefined
            ? undefined
            : config.protocol,
      })
      continue
    }

    const protocolHint = config.protocol
    const remoteUrl = config.url?.trim()
    const selectedProtocol: JsonRpcProtocol =
      protocolHint === 'streamable-http'
        ? 'streamable-http'
        : protocolHint === 'content-length'
          ? 'content-length'
          : protocolHint === 'newline-json'
            ? 'newline-json'
            : remoteUrl
              ? 'streamable-http'
              : 'content-length'

    const client: McpClientLike =
      selectedProtocol === 'streamable-http'
        ? new StreamableHttpMcpClient(serverName, config)
        : new StdioMcpClient(
            serverName,
            config,
            args.cwd,
            protocolCache[endpointKey],
          )

    try {
      await client.start()
      const descriptors = await client.listTools()
      const [resourcesResult, promptsResult] = await Promise.allSettled([
        client.listResources(),
        client.listPrompts(),
      ])
      const resourceCount =
        resourcesResult.status === 'fulfilled'
          ? resourcesResult.value.length
          : undefined
      const promptCount =
        promptsResult.status === 'fulfilled'
          ? promptsResult.value.length
          : undefined
      hasPublishedResources = hasPublishedResources || (resourceCount ?? 0) > 0
      hasPublishedPrompts = hasPublishedPrompts || (promptCount ?? 0) > 0
      clients.push(client)
      clientsByServer.set(serverName, client)
      const negotiated = client.getProtocol()
      if (
        negotiated &&
        negotiated !== 'streamable-http' &&
        protocolCache[endpointKey] !== negotiated
      ) {
        protocolCache[endpointKey] = negotiated
        protocolCacheDirty = true
      }

      for (const descriptor of descriptors) {
        const wrappedName = `mcp__${sanitizeToolSegment(serverName)}__${sanitizeToolSegment(
          descriptor.name,
        )}`
        const inputSchema = normalizeInputSchema(descriptor.inputSchema)
        tools.push({
          name: wrappedName,
          description:
            descriptor.description?.trim() ||
            `Call MCP tool ${descriptor.name} from server ${serverName}.`,
          inputSchema,
          schema: z.unknown(),
          async run(input) {
            return client.callTool(descriptor.name, input)
          },
        })
      }

      servers.push({
        name: serverName,
        command: summarizeServerEndpoint(config),
        status: 'connected',
        toolCount: descriptors.length,
        resourceCount,
        promptCount,
        protocol: client.getProtocol() ?? undefined,
      })
    } catch (error) {
      await client.close()
      servers.push({
        name: serverName,
        command: summarizeServerEndpoint(config),
        status: 'error',
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error),
        protocol:
          config.protocol === 'auto' || config.protocol === undefined
            ? undefined
            : config.protocol,
      })
    }
  }

  if (protocolCacheDirty) {
    await writeProtocolCache(protocolCache).catch(() => {
      // Ignore protocol cache persistence failures.
    })
  }

  if (clientsByServer.size > 0 && hasPublishedResources) {
    tools.push({
      name: 'list_mcp_resources',
      description: 'List optional MCP resources exposed by connected MCP servers when a server actually publishes them.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
        },
      },
      schema: z.object({
        server: z.string().optional(),
      }),
      async run(input: { server?: string }) {
        const targetClients = input.server
          ? [clientsByServer.get(input.server)].filter(
              (client): client is McpClientLike => client !== undefined,
            )
          : [...clientsByServer.values()]
        const lines: string[] = []
        for (const client of targetClients) {
          try {
            const resources = await client.listResources()
            for (const resource of resources) {
              lines.push(
                `${client.getServerName()}: ${resource.uri}${resource.name ? ` (${resource.name})` : ''}${resource.description ? ` - ${resource.description}` : ''}`,
              )
            }
          } catch (error) {
            lines.push(
              `${client.getServerName()}: failed to list resources (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
        return {
          ok: true,
          output:
            lines.length > 0
              ? lines.join('\n')
              : 'Connected MCP servers did not publish any MCP resources. This does not mean MCP tools are unavailable.',
        }
      },
    } satisfies ToolDefinition<{ server?: string }>)

    tools.push({
      name: 'read_mcp_resource',
      description: 'Read a specific optional MCP resource by server and URI.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          uri: { type: 'string' },
        },
        required: ['server', 'uri'],
      },
      schema: z.object({
        server: z.string().min(1),
        uri: z.string().min(1),
      }),
      async run(input: { server: string; uri: string }) {
        const client = clientsByServer.get(input.server)
        if (!client) {
          return {
            ok: false,
            output: `Unknown MCP server: ${input.server}`,
          }
        }
        return client.readResource(input.uri)
      },
    } satisfies ToolDefinition<{ server: string; uri: string }>)
  }

  if (clientsByServer.size > 0 && hasPublishedPrompts) {
    tools.push({
      name: 'list_mcp_prompts',
      description: 'List optional MCP prompts exposed by connected MCP servers when a server actually publishes them.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
        },
      },
      schema: z.object({
        server: z.string().optional(),
      }),
      async run(input: { server?: string }) {
        const targetClients = input.server
          ? [clientsByServer.get(input.server)].filter(
              (client): client is McpClientLike => client !== undefined,
            )
          : [...clientsByServer.values()]
        const lines: string[] = []
        for (const client of targetClients) {
          try {
            const prompts = await client.listPrompts()
            for (const prompt of prompts) {
              const argsSummary = (prompt.arguments ?? [])
                .map(arg => `${arg.name}${arg.required ? '*' : ''}`)
                .join(', ')
              lines.push(
                `${client.getServerName()}: ${prompt.name}${argsSummary ? ` args=[${argsSummary}]` : ''}${prompt.description ? ` - ${prompt.description}` : ''}`,
              )
            }
          } catch (error) {
            lines.push(
              `${client.getServerName()}: failed to list prompts (${error instanceof Error ? error.message : String(error)})`,
            )
          }
        }
        return {
          ok: true,
          output:
            lines.length > 0
              ? lines.join('\n')
              : 'Connected MCP servers did not publish any MCP prompts. This does not mean MCP tools are unavailable.',
        }
      },
    } satisfies ToolDefinition<{ server?: string }>)

    tools.push({
      name: 'get_mcp_prompt',
      description: 'Fetch a rendered optional MCP prompt by server, prompt name, and optional arguments.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          name: { type: 'string' },
          arguments: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['server', 'name'],
      },
      schema: z.object({
        server: z.string().min(1),
        name: z.string().min(1),
        arguments: z.record(z.string(), z.string()).optional(),
      }),
      async run(input: {
        server: string
        name: string
        arguments?: Record<string, string>
      }) {
        const client = clientsByServer.get(input.server)
        if (!client) {
          return {
            ok: false,
            output: `Unknown MCP server: ${input.server}`,
          }
        }
        return client.getPrompt(input.name, input.arguments)
      },
    } satisfies ToolDefinition<{
      server: string
      name: string
      arguments?: Record<string, string>
    }>)
  }

  return {
    tools,
    servers,
    async dispose() {
      await Promise.all(clients.map(client => client.close()))
    },
  }
}
