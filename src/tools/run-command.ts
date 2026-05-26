import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { registerBackgroundShellTask } from '../background-tasks.js'
import type { ToolDefinition } from '../tool.js'
import { resolveToolPath } from '../workspace.js'

const execFileAsync = promisify(execFile)

// Claude Code separates "read-only shell commands" from mutating/runtime commands.
// We keep the same shape here so safe observability commands are easy to extend.
const READONLY_COMMANDS = new Set([
  'pwd',
  'ls',
  'find',
  'rg',
  'grep',
  'cat',
  'head',
  'tail',
  'wc',
  'sed',
  'echo',
  'df',
  'du',
  'free',
  'uname',
  'uptime',
  'whoami',
])

const DEVELOPMENT_COMMANDS = new Set([
  'git',
  'npm',
  'node',
  'python3',
  'pytest',
  'bash',
  'sh',
  'bun',
])

// 检查命令是否在只读或开发命令白名单中
// Check if a command is in the readonly or development allowlist
function isAllowedCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command) || DEVELOPMENT_COMMANDS.has(command)
}

// 检查命令是否属于只读命令集合
// Check if a command belongs to the readonly commands set
function isReadOnlyCommand(command: string): boolean {
  return READONLY_COMMANDS.has(command)
}

type Input = {
  command: string
  args?: string[]
  cwd?: string
}

// 将命令行字符串按引号和转义规则拆分为参数数组
// Split a command-line string into argument parts, respecting quotes and escapes
function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of commandLine) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        parts.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (escaping) {
    current += '\\'
  }

  if (current.length > 0) {
    parts.push(current)
  }

  return parts
}

// 规范化命令输入：将单字符串命令解析为命令名称和参数数组
// Normalize command input by parsing a single-string command into name + args
function normalizeCommandInput(input: Input): {
  command: string
  args: string[]
} {
  if ((input.args?.length ?? 0) > 0) {
    return {
      command: input.command.trim(),
      args: input.args ?? [],
    }
  }

  const trimmed = input.command.trim()
  if (!trimmed) {
    return { command: '', args: [] }
  }

  // Accept single-string invocations like "git status" from the model.
  const parsed = splitCommandLine(trimmed)
  const [command = '', ...args] = parsed
  return { command, args }
}

// 检测命令行中是否包含 shell 管道或表达式的特殊字符
// Detect shell metacharacters indicating a pipeline or shell expression
function looksLikeShellSnippet(command: string, args?: string[]): boolean {
  if ((args?.length ?? 0) > 0) {
    return false
  }

  return /[|&;<>()$`]/.test(command)
}

// 检测命令是否应以后台方式运行（末尾有 & 且非 &&）
// Detect whether a command should run in the background (trailing &, not &&)
function isBackgroundShellSnippet(command: string, args?: string[]): boolean {
  if ((args?.length ?? 0) > 0) {
    return false
  }

  const trimmed = command.trim()
  return trimmed.endsWith('&') && !trimmed.endsWith('&&')
}

// 去除后台命令字符串末尾的 & 符号
// Remove the trailing & background operator from a command string
function stripTrailingBackgroundOperator(command: string): string {
  return command.trim().replace(/&\s*$/, '').trim()
}

export const runCommandTool: ToolDefinition<Input> = {
  name: 'run_command',
  description:
    'Run a common development command from an allowlist. For shell pipelines or variable expansion, pass the full snippet in command and code-lite will run it via bash -lc.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      args: {
        type: 'array',
        items: { type: 'string' },
      },
      cwd: { type: 'string' },
    },
    required: ['command'],
  },
  schema: z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
  }),
  // 运行开发或只读命令，支持 shell 管道、表达式和后台任务
  // Run a development or readonly command with support for shell snippets and background tasks
  async run(input, context) {
    const effectiveCwd = input.cwd
      ? await resolveToolPath(context, input.cwd, 'list')
      : context.cwd

    const normalized = normalizeCommandInput(input)
    if (!normalized.command) {
      return {
        ok: false,
        output: 'Command not allowed: empty command',
      }
    }

    const useShell = looksLikeShellSnippet(input.command, input.args)
    const backgroundShell = isBackgroundShellSnippet(input.command, input.args)

    const knownCommand = isAllowedCommand(normalized.command)

    const command = useShell ? 'bash' : normalized.command
    const args = useShell
      ? ['-lc', backgroundShell ? stripTrailingBackgroundOperator(input.command) : input.command]
      : normalized.args

    const forcePromptReason =
      !useShell && !knownCommand
        ? `Unknown command '${normalized.command}' is not in the built-in read-only/development set`
        : undefined

    if (forcePromptReason) {
      await context.permissions?.ensureCommand(command, args, effectiveCwd, {
        forcePromptReason,
      })
    } else if (useShell || !isReadOnlyCommand(normalized.command)) {
      await context.permissions?.ensureCommand(command, args, effectiveCwd)
    }

    if (useShell && backgroundShell) {
      const child = spawn(command, args, {
        cwd: effectiveCwd,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      })
      child.unref()

      const backgroundTask = registerBackgroundShellTask({
        command: stripTrailingBackgroundOperator(input.command),
        pid: child.pid ?? -1,
        cwd: effectiveCwd,
      })

      return {
        ok: true,
        output: `Background command started.\nTASK: ${backgroundTask.taskId}\nPID: ${backgroundTask.pid}`,
        backgroundTask,
      }
    }

    const result = await execFileAsync(command, args, {
      cwd: effectiveCwd,
      maxBuffer: 1024 * 1024,
      env: process.env,
    })

    return {
      ok: true,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
    }
  },
}
