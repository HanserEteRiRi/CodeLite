import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { ToolContext, ToolResult } from './tool.js'
import { isEnoentError } from './utils/errors.js'

// 生成文件变更的统一 diff 格式文本，用于权限审批时展示
// Builds a unified diff between before/after content for permission review display
export function buildUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return `(no changes for ${filePath})`
  }

  const raw = createTwoFilesPatch(
    `a/${filePath}`,
    `b/${filePath}`,
    before,
    after,
    '',
    '',
    { context: 3 },
  )

  // Strip the leading separator line to keep output compact in TUI approval.
  const lines = raw.split('\n')
  if (lines[0]?.startsWith('===')) {
    return lines.slice(1).join('\n')
  }
  return raw
}

// 读取文件现有内容，文件不存在时返回空字符串
// Reads existing file content, returning empty string when the file doesn't exist
export async function loadExistingFile(targetPath: string): Promise<string> {
  try {
    return await readFile(targetPath, 'utf8')
  } catch (error) {
    if (isEnoentError(error)) {
      return ''
    }

    throw error
  }
}

// 经过权限审核后应用文件变更：生成 diff → 权限检查 → 写入磁盘
// Applies a reviewed file change: generate diff → permission check → write to disk
export async function applyReviewedFileChange(
  context: ToolContext,
  filePath: string,
  targetPath: string,
  nextContent: string,
): Promise<ToolResult> {
  const previousContent = await loadExistingFile(targetPath)
  if (previousContent === nextContent) {
    return {
      ok: true,
      output: `No changes needed for ${filePath}`,
    }
  }

  const diff = buildUnifiedDiff(filePath, previousContent, nextContent)
  await context.permissions?.ensureEdit(targetPath, diff)

  await mkdir(path.dirname(targetPath), { recursive: true })
  await writeFile(targetPath, nextContent, 'utf8')

  return {
    ok: true,
    output: `Applied reviewed changes to ${filePath}`,
  }
}
