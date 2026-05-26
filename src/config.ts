import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isEnoentError } from './utils/errors.js'

export type CodeLiteSettings = {
  env?: Record<string, string | number>
  model?: string
  maxOutputTokens?: number
  mcpServers?: Record<string, McpServerConfig>
}

export type McpServerConfig = {
  command: string
  args?: string[]
  env?: Record<string, string | number>
  url?: string
  headers?: Record<string, string | number>
  cwd?: string
  enabled?: boolean
  protocol?: 'auto' | 'content-length' | 'newline-json' | 'streamable-http'
}

export type RuntimeConfig = {
  model: string
  baseUrl: string
  authToken?: string
  apiKey?: string
  maxOutputTokens?: number
  mcpServers: Record<string, McpServerConfig>
  sourceSummary: string
}

export type McpConfigScope = 'user' | 'project'

export const CODE_LITE_DIR = process.env.CODE_LITE_HOME
  ? path.resolve(process.env.CODE_LITE_HOME)
  : path.join(os.homedir(), '.code-lite')
export const CODE_LITE_SETTINGS_PATH = path.join(CODE_LITE_DIR, 'settings.json')
export const CODE_LITE_HISTORY_PATH = path.join(CODE_LITE_DIR, 'history.jsonl')
export const CODE_LITE_PERMISSIONS_PATH = path.join(CODE_LITE_DIR, 'permissions.json')
export const CODE_LITE_MCP_PATH = path.join(CODE_LITE_DIR, 'mcp.json')
export const CODE_LITE_MCP_TOKENS_PATH = path.join(CODE_LITE_DIR, 'mcp-tokens.json')
export const CODE_LITE_PROJECTS_DIR = path.join(CODE_LITE_DIR, 'projects')
export const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')
export const PROJECT_MCP_PATH = path.join(process.cwd(), '.mcp.json')

// 读取 MCP 令牌文件，返回服务器名称到令牌的映射
// Read the MCP tokens file and return a map of server names to tokens
export async function readMcpTokensFile(
  filePath = CODE_LITE_MCP_TOKENS_PATH,
): Promise<Record<string, string>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    return parsed as Record<string, string>
  } catch (error) {
    if (isEnoentError(error)) return {}
    throw error
  }
}

// 将 MCP 令牌映射持久化到磁盘文件
// Persist the MCP tokens map to a disk file
export async function saveMcpTokensFile(
  tokens: Record<string, string>,
  filePath = CODE_LITE_MCP_TOKENS_PATH,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(tokens, null, 2)}\n`, 'utf8')
}

// 从指定路径读取并解析 CodeLite 设置文件
// Read and parse a CodeLite settings file from the given path
async function readSettingsFile(filePath: string): Promise<CodeLiteSettings> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as CodeLiteSettings
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

// 从指定路径读取 MCP 配置文件，提取 mcpServers 字段
// Read an MCP config file from the given path and extract the mcpServers field
export async function readMcpConfigFile(
  filePath: string,
): Promise<Record<string, McpServerConfig>> {
  try {
    const content = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('mcpServers' in parsed) ||
      typeof parsed.mcpServers !== 'object' ||
      parsed.mcpServers === null
    ) {
      return {}
    }

    return parsed.mcpServers as Record<string, McpServerConfig>
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

// 根据作用域（用户或项目）返回 MCP 配置文件的路径
// Return the MCP config file path based on scope (user or project)
export function getMcpConfigPath(
  scope: McpConfigScope,
  cwd = process.cwd(),
): string {
  return scope === 'project' ? path.join(cwd, '.mcp.json') : CODE_LITE_MCP_PATH
}

// 加载指定作用域（用户或项目）下的 MCP 服务器配置
// Load MCP server configurations for the specified scope (user or project)
export async function loadScopedMcpServers(
  scope: McpConfigScope,
  cwd = process.cwd(),
): Promise<Record<string, McpServerConfig>> {
  return readMcpConfigFile(getMcpConfigPath(scope, cwd))
}

// 将 MCP 服务器配置保存到指定作用域的配置文件中
// Save MCP server configurations to the specified scope's config file
export async function saveScopedMcpServers(
  scope: McpConfigScope,
  servers: Record<string, McpServerConfig>,
  cwd = process.cwd(),
): Promise<void> {
  const targetPath = getMcpConfigPath(scope, cwd)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(
    targetPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    'utf8',
  )
}

// 合并两层设置，override 中的字段会深度合并覆盖 base
// Deep-merge two layers of settings, with override fields taking precedence over base
function mergeSettings(
  base: CodeLiteSettings,
  override: CodeLiteSettings,
): CodeLiteSettings {
  const mergedMcpServers = {
    ...(base.mcpServers ?? {}),
  }

  for (const [name, server] of Object.entries(override.mcpServers ?? {})) {
    mergedMcpServers[name] = {
      ...(mergedMcpServers[name] ?? {}),
      ...server,
      env: {
        ...(mergedMcpServers[name]?.env ?? {}),
        ...(server.env ?? {}),
      },
      headers: {
        ...(mergedMcpServers[name]?.headers ?? {}),
        ...(server.headers ?? {}),
      },
    }
  }

  return {
    ...base,
    ...override,
    env: {
      ...(base.env ?? {}),
      ...(override.env ?? {}),
    },
    mcpServers: mergedMcpServers,
  }
}

// 加载多层合并后的最终有效设置（Claude → 全局 MCP → 项目 MCP → CodeLite）
// Load the final effective settings merged from multiple layers (Claude → global MCP → project MCP → CodeLite)
export async function loadEffectiveSettings(): Promise<CodeLiteSettings> {
  const [claudeSettings, globalMcpConfig, projectMcpConfig, codeLiteSettings] =
    await Promise.all([
      readSettingsFile(CLAUDE_SETTINGS_PATH),
      readMcpConfigFile(CODE_LITE_MCP_PATH),
      readMcpConfigFile(PROJECT_MCP_PATH),
      readSettingsFile(CODE_LITE_SETTINGS_PATH),
    ])
  return mergeSettings(
    mergeSettings(
      mergeSettings(claudeSettings, { mcpServers: globalMcpConfig }),
      { mcpServers: projectMcpConfig },
    ),
    codeLiteSettings,
  )
}

// 将部分设置更新合并保存到 ~/.code-lite/settings.json
// Merge partial setting updates into ~/.code-lite/settings.json and persist
export async function saveCodeLiteSettings(
  updates: CodeLiteSettings,
): Promise<void> {
  await mkdir(CODE_LITE_DIR, { recursive: true })
  const existing = await readSettingsFile(CODE_LITE_SETTINGS_PATH)
  const next = mergeSettings(existing, updates)
  await writeFile(
    CODE_LITE_SETTINGS_PATH,
    `${JSON.stringify(next, null, 2)}\n`,
    'utf8',
  )
}

// 加载运行时配置：合并设置文件和环境变量，解析 model/baseUrl/auth
// Load runtime config: merge settings files with env vars, resolve model/baseUrl/auth
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const effectiveSettings = await loadEffectiveSettings()
  const env = {
    ...(effectiveSettings.env ?? {}),
    ...process.env,
  }

  const model =
    process.env.CODE_LITE_MODEL ||
    effectiveSettings.model ||
    String(env.ANTHROPIC_MODEL ?? '').trim()

  const baseUrl =
    String(env.ANTHROPIC_BASE_URL ?? '').trim()
  const authToken = String(env.ANTHROPIC_AUTH_TOKEN ?? '').trim() || undefined
  const apiKey = String(env.ANTHROPIC_API_KEY ?? '').trim() || undefined
  const rawMaxOutputTokens =
    process.env.CODE_LITE_MAX_OUTPUT_TOKENS ??
    effectiveSettings.maxOutputTokens ??
    env.CODE_LITE_MAX_OUTPUT_TOKENS
  const parsedMaxOutputTokens =
    rawMaxOutputTokens === undefined ? NaN : Number(rawMaxOutputTokens)
  const maxOutputTokens =
    Number.isFinite(parsedMaxOutputTokens) && parsedMaxOutputTokens > 0
      ? Math.floor(parsedMaxOutputTokens)
      : undefined

  if (!model) {
    throw new Error(
      `No model configured. Set ~/.code-lite/settings.json or env.ANTHROPIC_MODEL.`,
    )
  }

  if (!authToken && !apiKey) {
    throw new Error(
      `No auth configured. Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY in ~/.code-lite/settings.json or process env.`,
    )
  }

  if (!baseUrl) {
    throw new Error(
      `No API base URL configured. Set ANTHROPIC_BASE_URL in ~/.code-lite/settings.json or process env.`,
    )
  }

  return {
    model,
    baseUrl,
    authToken,
    apiKey,
    maxOutputTokens,
    mcpServers: effectiveSettings.mcpServers ?? {},
    sourceSummary: `config: ${CODE_LITE_SETTINGS_PATH} > ${CLAUDE_SETTINGS_PATH} > process.env`,
  }
}
