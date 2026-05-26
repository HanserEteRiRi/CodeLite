import {
  type McpConfigScope,
  type McpServerConfig,
  CODE_LITE_MCP_TOKENS_PATH,
  getMcpConfigPath,
  loadScopedMcpServers,
  readMcpTokensFile,
  saveMcpTokensFile,
  saveScopedMcpServers,
} from './config.js'
import { discoverSkills, installSkill, removeManagedSkill } from './skills.js'

// 打印 code-lite 管理命令的使用说明
// Print usage instructions for code-lite management commands
function printUsage(): void {
  console.log(`codelite management commands

codelite mcp list [--project]
codelite mcp add <name> [--project] [--protocol <auto|content-length|newline-json|streamable-http>] [--url <endpoint>] [--header KEY=VALUE ...] [--env KEY=VALUE ...] [-- <command> [args...]]
codelite mcp login <name> --token <bearer-token>
codelite mcp logout <name>
codelite mcp remove <name> [--project]

codelite skills list
codelite skills add <path-to-skill-or-dir> [--name <name>] [--project]
codelite skills remove <name> [--project]`)
}

// 从命令行参数中解析 --project 标志以确定作用域（用户或项目）
// Parse the --project flag from command-line arguments to determine scope (user or project)
function parseScope(args: string[]): {
  scope: McpConfigScope
  rest: string[]
} {
  const rest = [...args]
  const projectIndex = rest.indexOf('--project')
  if (projectIndex !== -1) {
    rest.splice(projectIndex, 1)
    return { scope: 'project', rest }
  }
  return { scope: 'user', rest }
}

// 从参数数组中提取并消费一个带值的命名选项（如 --name value）
// Extract and consume a named option with a value from the arguments array (e.g. --name value)
function takeOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value) {
    throw new Error(`Missing value for ${name}`)
  }
  args.splice(index, 2)
  return value
}

// 从参数数组中提取并消费所有重复出现的命名选项值（如 --env KEY=VALUE）
// Extract and consume all repeated occurrences of a named option from the arguments array (e.g. --env KEY=VALUE)
function takeRepeatOption(args: string[], name: string): string[] {
  const values: string[] = []
  while (true) {
    const index = args.indexOf(name)
    if (index === -1) break
    const value = args[index + 1]
    if (!value) {
      throw new Error(`Missing value for ${name}`)
    }
    values.push(value)
    args.splice(index, 2)
  }
  return values
}

// 将 KEY=VALUE 格式的字符串数组解析为环境变量键值对记录
// Parse an array of KEY=VALUE strings into an environment variable key-value record
function parseEnvPairs(values: string[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of values) {
    const separator = entry.indexOf('=')
    if (separator === -1) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    const key = entry.slice(0, separator).trim()
    const value = entry.slice(separator + 1)
    if (!key) {
      throw new Error(`Invalid --env value: ${entry}`)
    }
    env[key] = value
  }
  return env
}

// 处理 MCP 管理子命令：list、add、remove、login、logout
// Handle MCP management subcommands: list, add, remove, login, logout
async function handleMcpCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const servers = await loadScopedMcpServers(scope, cwd)
    if (Object.keys(servers).length === 0) {
      console.log(`No MCP servers configured in ${getMcpConfigPath(scope, cwd)}.`)
      return true
    }

    for (const [name, server] of Object.entries(servers)) {
      const endpoint =
        server.url?.trim() ||
        `${server.command ?? ''} ${server.args?.join(' ') ?? ''}`.trim()
      const protocol = server.protocol ? ` protocol=${server.protocol}` : ''
      console.log(`${name}: ${endpoint}${protocol}`.trim())
    }
    return true
  }

  if (subcommand === 'add') {
    const separatorIndex = rest.indexOf('--')
    const head = separatorIndex === -1 ? [...rest] : rest.slice(0, separatorIndex)
    const commandParts = separatorIndex === -1 ? [] : rest.slice(separatorIndex + 1)
    const name = head.shift()
    if (!name) {
      throw new Error('Missing MCP server name.')
    }

    const protocol = takeOption(head, '--protocol') as McpServerConfig['protocol']
    const url = takeOption(head, '--url')?.trim()
    const env = parseEnvPairs(takeRepeatOption(head, '--env'))
    const headers = parseEnvPairs(takeRepeatOption(head, '--header'))
    if (head.length > 0) {
      throw new Error(`Unknown arguments: ${head.join(' ')}`)
    }

    const hasUrl = Boolean(url)
    const hasCommand = commandParts.length > 0
    if (hasUrl && hasCommand) {
      throw new Error('Cannot set both --url and local command. Choose one.')
    }
    if (!hasUrl && !hasCommand) {
      throw new Error('Missing MCP command or --url.')
    }
    if (protocol === 'streamable-http' && !hasUrl) {
      throw new Error('Protocol streamable-http requires --url.')
    }

    const [command = '', ...commandArgs] = commandParts
    const existing = await loadScopedMcpServers(scope, cwd)
    existing[name] = {
      command,
      args: hasCommand ? commandArgs : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      url: hasUrl ? url : undefined,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      protocol,
    }
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Added MCP server ${name} to ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const existing = await loadScopedMcpServers(scope, cwd)
    if (!(name in existing)) {
      console.log(`MCP server ${name} not found in ${getMcpConfigPath(scope, cwd)}`)
      return true
    }
    delete existing[name]
    await saveScopedMcpServers(scope, existing, cwd)
    console.log(`Removed MCP server ${name} from ${getMcpConfigPath(scope, cwd)}`)
    return true
  }

  if (subcommand === 'login') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const token = takeOption(rest, '--token')?.trim()
    if (!token) {
      throw new Error('Missing --token value.')
    }
    if (rest.length > 1) {
      throw new Error(`Unknown arguments: ${rest.slice(1).join(' ')}`)
    }
    const tokens = await readMcpTokensFile()
    tokens[name] = token
    await saveMcpTokensFile(tokens)
    console.log(`Stored MCP token for ${name} in ${CODE_LITE_MCP_TOKENS_PATH}`)
    return true
  }

  if (subcommand === 'logout') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing MCP server name.')
    }
    const tokens = await readMcpTokensFile()
    if (!(name in tokens)) {
      console.log(`No token found for ${name} in ${CODE_LITE_MCP_TOKENS_PATH}`)
      return true
    }
    delete tokens[name]
    await saveMcpTokensFile(tokens)
    console.log(`Removed MCP token for ${name} from ${CODE_LITE_MCP_TOKENS_PATH}`)
    return true
  }

  printUsage()
  return true
}

// 处理技能管理子命令：list、add、remove
// Handle skills management subcommands: list, add, remove
async function handleSkillsCommand(cwd: string, args: string[]): Promise<boolean> {
  const [subcommand, ...restArgs] = args
  if (!subcommand) {
    printUsage()
    return true
  }

  const { scope, rest } = parseScope(restArgs)

  if (subcommand === 'list') {
    const skills = await discoverSkills(cwd)
    if (skills.length === 0) {
      console.log('No skills discovered.')
      return true
    }
    for (const skill of skills) {
      console.log(`${skill.name}: ${skill.description} (${skill.path})`)
    }
    return true
  }

  if (subcommand === 'add') {
    const sourcePath = rest[0]
    if (!sourcePath) {
      throw new Error('Missing skill source path.')
    }
    const name = takeOption(rest, '--name')
    const result = await installSkill({
      cwd,
      sourcePath,
      name,
      scope,
    })
    console.log(`Installed skill ${result.name} at ${result.targetPath}`)
    return true
  }

  if (subcommand === 'remove') {
    const name = rest[0]
    if (!name) {
      throw new Error('Missing skill name.')
    }
    const result = await removeManagedSkill({
      cwd,
      name,
      scope,
    })
    if (!result.removed) {
      console.log(`Skill ${name} not found at ${result.targetPath}`)
      return true
    }
    console.log(`Removed skill ${name} from ${result.targetPath}`)
    return true
  }

  printUsage()
  return true
}

// 入口函数：判断命令行参数是否为管理命令（mcp/skills/help），如果是则处理并返回 true
// Entry point: check if the CLI arguments represent a management command (mcp/skills/help) and handle them, returning true if handled
export async function maybeHandleManagementCommand(
  cwd: string,
  argv: string[],
): Promise<boolean> {
  const [category, ...rest] = argv
  if (!category) {
    return false
  }

  if (category === 'mcp') {
    return handleMcpCommand(cwd, rest)
  }

  if (category === 'skills') {
    return handleSkillsCommand(cwd, rest)
  }

  if (category === 'help' || category === '--help' || category === '-h') {
    printUsage()
    return true
  }

  return false
}
