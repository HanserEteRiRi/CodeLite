import process from 'node:process'
import type { BackgroundTaskResult } from './tool.js'
import { getErrorCode } from './utils/errors.js'

type BackgroundTaskRecord = BackgroundTaskResult & {
  cwd: string
}

const tasks = new Map<string, BackgroundTaskRecord>()

// 生成唯一后台任务 ID（时间戳 + 随机字符串）
// Generates a unique background task ID from timestamp and random suffix
function makeTaskId(): string {
  return `shell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// 刷新后台任务状态（检查进程是否仍在运行，更新 completed/failed）
// Refreshes a background task record by checking if the process is still alive
function refreshRecord(record: BackgroundTaskRecord): BackgroundTaskRecord {
  if (record.status !== 'running') {
    return record
  }

  try {
    process.kill(record.pid, 0)
    return record
  } catch (error) {
    const code = getErrorCode(error)
    if (code === 'ESRCH') {
      const next = {
        ...record,
        status: 'completed' as const,
      }
      tasks.set(record.taskId, next)
      return next
    }

    const next = {
      ...record,
      status: 'failed' as const,
    }
    tasks.set(record.taskId, next)
    return next
  }
}

// 注册一个后台 shell 任务，返回任务信息供 agent-loop 追踪
// Registers a background shell task and returns its info for agent-loop tracking
export function registerBackgroundShellTask(args: {
  command: string
  pid: number
  cwd: string
}): BackgroundTaskResult {
  const task: BackgroundTaskRecord = {
    taskId: makeTaskId(),
    type: 'local_bash',
    command: args.command,
    pid: args.pid,
    cwd: args.cwd,
    status: 'running',
    startedAt: Date.now(),
  }
  tasks.set(task.taskId, task)
  return task
}

// 列出所有已注册的后台任务并刷新各自状态
// Lists all registered background tasks with their refreshed statuses
export function listBackgroundTasks(): BackgroundTaskResult[] {
  return [...tasks.values()].map(refreshRecord)
}

// 按 ID 获取单个后台任务的当前状态
// Gets a single background task by ID with its refreshed status
export function getBackgroundTask(taskId: string): BackgroundTaskResult | null {
  const task = tasks.get(taskId)
  if (!task) {
    return null
  }
  return refreshRecord(task)
}
