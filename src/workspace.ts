import path from 'node:path'
import type { ToolContext } from './tool.js'

// 解析工具操作的路径，执行工作区越界检查和权限验证
// Resolve a tool target path with workspace escape checks and permission enforcement
export async function resolveToolPath(
  context: ToolContext,
  targetPath: string,
  intent: 'read' | 'write' | 'list' | 'search',
): Promise<string> {
  const resolved = path.resolve(context.cwd, targetPath)

  if (!context.permissions) {
    const workspaceRoot = path.resolve(context.cwd)
    const relative = path.relative(workspaceRoot, resolved)

    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(`Path escapes workspace: ${targetPath}`)
    }

    return resolved
  }

  await context.permissions.ensurePathAccess(resolved, intent)
  return resolved
}
