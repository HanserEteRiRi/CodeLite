import { z } from 'zod'
import type { PermissionManager } from './permissions.js'
import type { SkillSummary } from './skills.js'
import type { McpServerSummary } from './mcp.js'

export type ToolContext = {
  cwd: string
  permissions?: PermissionManager
}

export type BackgroundTaskResult = {
  taskId: string
  type: 'local_bash'
  command: string
  pid: number
  status: 'running' | 'completed' | 'failed'
  startedAt: number
}

export type ToolResult = {
  ok: boolean
  output: string
  backgroundTask?: BackgroundTaskResult
  awaitUser?: boolean
}

export type ToolDefinition<TInput> = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  schema: z.ZodType<TInput>
  run(input: TInput, context: ToolContext): Promise<ToolResult>
}

type ToolRegistryMetadata = {
  skills?: SkillSummary[]
  mcpServers?: McpServerSummary[]
}

export class ToolRegistry {
  private readonly toolsStore: ToolDefinition<unknown>[]
  private metadataStore: ToolRegistryMetadata
  private readonly disposers: Array<() => Promise<void>> = []

  constructor(
    tools: ToolDefinition<unknown>[],
    metadata: ToolRegistryMetadata = {},
    disposer?: () => Promise<void>,
  ) {
    this.toolsStore = [...tools]
    this.metadataStore = metadata
    if (disposer) {
      this.disposers.push(disposer)
    }
  }

  // 返回当前注册的所有工具定义列表
  // Returns the list of all currently registered tool definitions
  list(): ToolDefinition<unknown>[] {
    return this.toolsStore
  }

  // 获取已注册的技能摘要列表
  // Returns the list of registered skill summaries
  getSkills(): SkillSummary[] {
    return this.metadataStore.skills ?? []
  }

  // 获取已注册的 MCP 服务器摘要列表
  // Returns the list of registered MCP server summaries
  getMcpServers(): McpServerSummary[] {
    return this.metadataStore.mcpServers ?? []
  }

  // 设置/替换 MCP 服务器摘要列表
  // Sets or replaces the MCP server summary list
  setMcpServers(servers: McpServerSummary[]): void {
    this.metadataStore = {
      ...this.metadataStore,
      mcpServers: [...servers],
    }
  }

  // 批量添加工具定义，跳过已存在同名工具，避免重复注册
  // Adds a batch of tool definitions, skipping tools that already exist by name to avoid duplicate registration
  addTools(nextTools: ToolDefinition<unknown>[]): void {
    const existingNames = new Set(this.toolsStore.map(tool => tool.name))
    for (const tool of nextTools) {
      if (existingNames.has(tool.name)) {
        continue
      }
      this.toolsStore.push(tool)
      existingNames.add(tool.name)
    }
  }

  // 注册一个 disposer 函数，在 dispose() 时统一调用以释放资源
  // Registers a disposer function that will be called during dispose() to release resources
  addDisposer(disposer: () => Promise<void>): void {
    this.disposers.push(disposer)
  }

  // 按名称查找工具定义，未找到时返回 undefined
  // Looks up a tool definition by name; returns undefined if not found
  find(name: string): ToolDefinition<unknown> | undefined {
    return this.toolsStore.find(tool => tool.name === name)
  }

  // 执行工具：按名称查找、Zod 校验输入、调用 run 并捕获异常
  // Executes a tool: looks up by name, validates input with Zod, invokes run, and catches exceptions
  async execute(
    toolName: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.find(toolName)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolName}`,
      }
    }

    const parsed = tool.schema.safeParse(input)
    if (!parsed.success) {
      return {
        ok: false,
        output: parsed.error.message,
      }
    }

    try {
      return await tool.run(parsed.data, context)
    } catch (error) {
      return {
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // 释放所有已注册的 disposer 资源（如 MCP 连接、子进程等）
  // Releases all registered disposer resources (e.g., MCP connections, child processes)
  async dispose(): Promise<void> {
    await Promise.all(this.disposers.map(disposer => disposer()))
  }
}
