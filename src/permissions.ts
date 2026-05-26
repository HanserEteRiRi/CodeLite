import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { CODE_LITE_DIR } from './config.js'
import { isEnoentError } from './utils/errors.js'

export type PermissionDecision =
  | 'allow_once'
  | 'allow_always'
  | 'allow_turn'
  | 'allow_all_turn'
  | 'deny_once'
  | 'deny_always'
  | 'deny_with_feedback'

export type PermissionChoice = {
  key: string
  label: string
  decision: PermissionDecision
}

export type PermissionPromptResult = {
  decision: PermissionDecision
  feedback?: string
}

type EnsureCommandOptions = {
  forcePromptReason?: string
}

export type PermissionRequest = {
  kind: 'path' | 'command' | 'edit'
  summary: string
  details: string[]
  scope: string
  choices: PermissionChoice[]
}

export type PermissionPromptHandler = (
  request: PermissionRequest,
) => Promise<PermissionPromptResult>

type PermissionStore = {
  allowedDirectoryPrefixes?: string[]
  deniedDirectoryPrefixes?: string[]
  allowedCommandPatterns?: string[]
  deniedCommandPatterns?: string[]
  allowedEditPatterns?: string[]
  deniedEditPatterns?: string[]
}

type PathIntent = 'read' | 'write' | 'list' | 'search' | 'command_cwd'

const PERMISSIONS_PATH = path.join(CODE_LITE_DIR, 'permissions.json')

// 将路径解析为规范化的绝对路径
// Resolve a path to its normalized absolute form
function normalizePath(targetPath: string): string {
  return path.resolve(targetPath)
}

// 检查目标路径是否在指定根目录之内
// Check whether the target path lies within the given root directory
function isWithinDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  )
}

// 检查目标路径是否匹配任意一个目录前缀（包含关系）
// Check whether the target path falls within any of the given directory prefixes
function matchesDirectoryPrefix(
  targetPath: string,
  directories: Iterable<string>,
): boolean {
  for (const directory of directories) {
    if (isWithinDirectory(directory, targetPath)) {
      return true
    }
  }

  return false
}

// 将命令及其参数格式化为完整的命令签名字符串
// Format a command and its arguments into a complete command signature string
function formatCommandSignature(command: string, args: string[]): string {
  return [command, ...args].join(' ').trim()
}

// 判断命令是否属于危险操作（如 git reset --hard、npm publish 等），返回风险描述或 null
// Classify whether a command is dangerous (e.g. git reset --hard, npm publish) and return a risk description or null
function classifyDangerousCommand(command: string, args: string[]): string | null {
  const normalizedArgs = args.map(arg => arg.trim()).filter(Boolean)
  const signature = formatCommandSignature(command, normalizedArgs)

  if (command === 'git') {
    if (normalizedArgs.includes('reset') && normalizedArgs.includes('--hard')) {
      return `git reset --hard can discard local changes (${signature})`
    }

    if (normalizedArgs.includes('clean')) {
      return `git clean can delete untracked files (${signature})`
    }

    if (
      normalizedArgs.includes('checkout') &&
      normalizedArgs.includes('--')
    ) {
      return `git checkout -- can overwrite working tree files (${signature})`
    }

    if (
      normalizedArgs.includes('restore') &&
      normalizedArgs.some(arg => arg.startsWith('--source'))
    ) {
      return `git restore --source can overwrite local files (${signature})`
    }

    if (
      normalizedArgs.includes('push') &&
      normalizedArgs.some(arg => arg === '--force' || arg === '-f')
    ) {
      return `git push --force rewrites remote history (${signature})`
    }
  }

  if (command === 'npm' && normalizedArgs.includes('publish')) {
    return `npm publish affects a registry outside this machine (${signature})`
  }

  if (
    command === 'node' ||
    command === 'python3' ||
    command === 'bun' ||
    command === 'bash' ||
    command === 'sh'
  ) {
    return `${command} can execute arbitrary local code (${signature})`
  }

  return null
}

// 从磁盘读取并解析权限存储文件
// Read and parse the permission store file from disk
async function readPermissionStore(): Promise<PermissionStore> {
  try {
    const content = await readFile(PERMISSIONS_PATH, 'utf8')
    return JSON.parse(content) as PermissionStore
  } catch (error) {
    if (isEnoentError(error)) {
      return {}
    }

    throw error
  }
}

// 将权限存储对象持久化写入磁盘文件
// Persist the permission store object to a disk file
async function writePermissionStore(store: PermissionStore): Promise<void> {
  await mkdir(CODE_LITE_DIR, { recursive: true })
  await writeFile(PERMISSIONS_PATH, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

export class PermissionManager {
  private readonly allowedDirectoryPrefixes = new Set<string>()
  private readonly deniedDirectoryPrefixes = new Set<string>()
  private readonly sessionAllowedPaths = new Set<string>()
  private readonly sessionDeniedPaths = new Set<string>()
  private readonly allowedCommandPatterns = new Set<string>()
  private readonly deniedCommandPatterns = new Set<string>()
  private readonly sessionAllowedCommands = new Set<string>()
  private readonly sessionDeniedCommands = new Set<string>()
  private readonly allowedEditPatterns = new Set<string>()
  private readonly deniedEditPatterns = new Set<string>()
  private readonly sessionAllowedEdits = new Set<string>()
  private readonly sessionDeniedEdits = new Set<string>()
  private readonly turnAllowedEdits = new Set<string>()
  private turnAllowAllEdits = false
  private ready: Promise<void>

  constructor(
    private readonly workspaceRoot: string,
    private readonly prompt?: PermissionPromptHandler,
  ) {
    this.ready = this.initialize()
  }

  // 从持久化存储中加载已保存的权限规则到内存集合
  // Load previously saved permission rules from persistent storage into in-memory sets
  private async initialize(): Promise<void> {
    const store = await readPermissionStore()

    for (const directory of store.allowedDirectoryPrefixes ?? []) {
      this.allowedDirectoryPrefixes.add(normalizePath(directory))
    }

    for (const directory of store.deniedDirectoryPrefixes ?? []) {
      this.deniedDirectoryPrefixes.add(normalizePath(directory))
    }

    for (const pattern of store.allowedCommandPatterns ?? []) {
      this.allowedCommandPatterns.add(pattern)
    }

    for (const pattern of store.deniedCommandPatterns ?? []) {
      this.deniedCommandPatterns.add(pattern)
    }

    for (const pattern of store.allowedEditPatterns ?? []) {
      this.allowedEditPatterns.add(normalizePath(pattern))
    }

    for (const pattern of store.deniedEditPatterns ?? []) {
      this.deniedEditPatterns.add(normalizePath(pattern))
    }
  }

  // 等待权限管理器初始化完成
  // Wait until the permission manager has finished initializing
  async whenReady(): Promise<void> {
    await this.ready
  }

  // 开始新的对话轮次，清除上一轮的临时编辑许可
  // Start a new conversation turn, clearing temporary edit allowances from the previous turn
  beginTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  // 结束当前对话轮次，清除本轮的临时编辑许可
  // End the current conversation turn, clearing this turn's temporary edit allowances
  endTurn(): void {
    this.turnAllowedEdits.clear()
    this.turnAllowAllEdits = false
  }

  // 生成当前权限状态的摘要信息（工作目录、允许的路径和命令等）
  // Generate a summary of the current permission state (cwd, allowed paths and commands, etc.)
  getSummary(): string[] {
    const summary = [`cwd: ${this.workspaceRoot}`]

    if (this.allowedDirectoryPrefixes.size > 0) {
      summary.push(
        `extra allowed dirs: ${[...this.allowedDirectoryPrefixes].slice(0, 4).join(', ')}`,
      )
    } else {
      summary.push('extra allowed dirs: none')
    }

    if (this.allowedCommandPatterns.size > 0) {
      summary.push(
        `dangerous allowlist: ${[...this.allowedCommandPatterns].slice(0, 4).join(', ')}`,
      )
    } else {
      summary.push('dangerous allowlist: none')
    }

    if (this.allowedEditPatterns.size > 0) {
      summary.push(
        `trusted edit targets: ${[...this.allowedEditPatterns].slice(0, 2).join(', ')}`,
      )
    }

    return summary
  }

  // 将当前内存中的权限规则持久化写入磁盘
  // Persist the current in-memory permission rules to disk
  private async persist(): Promise<void> {
    await writePermissionStore({
      allowedDirectoryPrefixes: [...this.allowedDirectoryPrefixes],
      deniedDirectoryPrefixes: [...this.deniedDirectoryPrefixes],
      allowedCommandPatterns: [...this.allowedCommandPatterns],
      deniedCommandPatterns: [...this.deniedCommandPatterns],
      allowedEditPatterns: [...this.allowedEditPatterns],
      deniedEditPatterns: [...this.deniedEditPatterns],
    })
  }

  // 检查并授权对目标路径的访问（读/写/列表/搜索/命令执行目录），必要时触发用户提示
  // Check and authorize access to a target path (read/write/list/search/command_cwd), prompting the user if needed
  async ensurePathAccess(targetPath: string, intent: PathIntent): Promise<void> {
    await this.ready

    const normalizedTarget = normalizePath(targetPath)
    if (isWithinDirectory(this.workspaceRoot, normalizedTarget)) {
      return
    }

    if (
      this.sessionDeniedPaths.has(normalizedTarget) ||
      matchesDirectoryPrefix(normalizedTarget, this.deniedDirectoryPrefixes)
    ) {
      throw new Error(`Access denied for path outside cwd: ${normalizedTarget}`)
    }

    if (
      this.sessionAllowedPaths.has(normalizedTarget) ||
      matchesDirectoryPrefix(normalizedTarget, this.allowedDirectoryPrefixes)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Path ${normalizedTarget} is outside cwd ${this.workspaceRoot}. Start codelite in TTY mode to approve it.`,
      )
    }

    const scopeDirectory =
      intent === 'list' || intent === 'command_cwd'
        ? normalizedTarget
        : path.dirname(normalizedTarget)

    const promptResult = await this.prompt({
      kind: 'path',
      summary: `code-lite wants ${intent.replace('_', ' ')} access outside the current cwd`,
      details: [
        `cwd: ${this.workspaceRoot}`,
        `target: ${normalizedTarget}`,
        `scope directory: ${scopeDirectory}`,
      ],
      scope: scopeDirectory,
      choices: [
        { key: 'y', label: 'allow once', decision: 'allow_once' },
        { key: 'a', label: 'allow this directory', decision: 'allow_always' },
        { key: 'n', label: 'deny once', decision: 'deny_once' },
        { key: 'd', label: 'deny this directory', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedPaths.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedDirectoryPrefixes.add(scopeDirectory)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedDirectoryPrefixes.add(scopeDirectory)
      await this.persist()
    } else {
      this.sessionDeniedPaths.add(normalizedTarget)
    }

    throw new Error(`Access denied for path outside cwd: ${normalizedTarget}`)
  }

  // 检查命令执行权限：先验证目录访问，再对危险命令进行安全审查并提示用户
  // Check command execution permissions: verify directory access first, then review dangerous commands and prompt the user
  async ensureCommand(
    command: string,
    args: string[],
    commandCwd: string,
    options?: EnsureCommandOptions,
  ): Promise<void> {
    await this.ready

    await this.ensurePathAccess(commandCwd, 'command_cwd')

    const dangerousReason = classifyDangerousCommand(command, args)
    const reason = options?.forcePromptReason?.trim() || dangerousReason
    if (!reason) {
      return
    }

    const signature = formatCommandSignature(command, args)
    if (
      this.sessionDeniedCommands.has(signature) ||
      this.deniedCommandPatterns.has(signature)
    ) {
      throw new Error(`Command denied: ${signature}`)
    }

    if (
      this.sessionAllowedCommands.has(signature) ||
      this.allowedCommandPatterns.has(signature)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Command requires approval: ${signature}. Start codelite in TTY mode to approve it.`,
      )
    }

    const promptResult = await this.prompt({
      kind: 'command',
      summary: options?.forcePromptReason
        ? 'code-lite wants approval for this command'
        : 'code-lite wants to run a dangerous command',
      details: [
        `cwd: ${commandCwd}`,
        `command: ${signature}`,
        `reason: ${reason}`,
      ],
      scope: signature,
      choices: [
        { key: 'y', label: 'allow once', decision: 'allow_once' },
        { key: 'a', label: 'always allow this command', decision: 'allow_always' },
        { key: 'n', label: 'deny once', decision: 'deny_once' },
        { key: 'd', label: 'always deny this command', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedCommands.add(signature)
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedCommandPatterns.add(signature)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedCommandPatterns.add(signature)
      await this.persist()
    } else {
      this.sessionDeniedCommands.add(signature)
    }

    throw new Error(`Command denied: ${signature}`)
  }

  // 检查文件编辑权限：显示差异预览并提示用户批准或拒绝修改
  // Check file edit permissions: show a diff preview and prompt the user to approve or deny the modification
  async ensureEdit(targetPath: string, diffPreview: string): Promise<void> {
    await this.ready

    const normalizedTarget = normalizePath(targetPath)

    if (
      this.sessionDeniedEdits.has(normalizedTarget) ||
      this.deniedEditPatterns.has(normalizedTarget)
    ) {
      throw new Error(`Edit denied: ${normalizedTarget}`)
    }

    if (
      this.sessionAllowedEdits.has(normalizedTarget) ||
      this.turnAllowedEdits.has(normalizedTarget) ||
      this.turnAllowAllEdits ||
      this.allowedEditPatterns.has(normalizedTarget)
    ) {
      return
    }

    if (!this.prompt) {
      throw new Error(
        `Edit requires approval: ${normalizedTarget}. Start codelite in TTY mode to review it.`,
      )
    }

    const promptResult = await this.prompt({
      kind: 'edit',
      summary: 'code-lite wants to apply a file modification',
      details: [
        `target: ${normalizedTarget}`,
        '',
        diffPreview,
      ],
      scope: normalizedTarget,
      choices: [
        { key: '1', label: 'apply once', decision: 'allow_once' },
        { key: '2', label: 'allow this file in this turn', decision: 'allow_turn' },
        { key: '3', label: 'allow all edits in this turn', decision: 'allow_all_turn' },
        { key: '4', label: 'always allow this file', decision: 'allow_always' },
        { key: '5', label: 'reject once', decision: 'deny_once' },
        { key: '6', label: 'reject and send guidance to model', decision: 'deny_with_feedback' },
        { key: '7', label: 'always reject this file', decision: 'deny_always' },
      ],
    })

    if (promptResult.decision === 'allow_once') {
      this.sessionAllowedEdits.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_turn') {
      this.turnAllowedEdits.add(normalizedTarget)
      return
    }

    if (promptResult.decision === 'allow_all_turn') {
      this.turnAllowAllEdits = true
      return
    }

    if (promptResult.decision === 'allow_always') {
      this.allowedEditPatterns.add(normalizedTarget)
      await this.persist()
      return
    }

    if (promptResult.decision === 'deny_with_feedback') {
      const guidance = promptResult.feedback?.trim()
      if (guidance) {
        throw new Error(
          `Edit denied: ${normalizedTarget}\nUser guidance: ${guidance}`,
        )
      }
      this.sessionDeniedEdits.add(normalizedTarget)
      throw new Error(`Edit denied: ${normalizedTarget}`)
    }

    if (promptResult.decision === 'deny_always') {
      this.deniedEditPatterns.add(normalizedTarget)
      await this.persist()
    } else {
      this.sessionDeniedEdits.add(normalizedTarget)
    }

    throw new Error(`Edit denied: ${normalizedTarget}`)
  }
}

// 返回权限存储文件的磁盘路径
// Return the disk path of the permission store file
export function getPermissionsPath(): string {
  return PERMISSIONS_PATH
}
