// 从错误对象或其 cause 中提取标准的错误码字符串
// Extract a standard error code string from an error or its cause
export function getErrorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code
  }

  if (
    error instanceof Error &&
    typeof error.cause === 'object' &&
    error.cause !== null &&
    'code' in error.cause &&
    typeof (error.cause as { code?: unknown }).code === 'string'
  ) {
    return (error.cause as { code: string }).code
  }

  return null
}

// 判断错误是否为文件不存在的 ENOENT 错误
// Check whether an error is an ENOENT (file not found) error
export function isEnoentError(error: unknown): boolean {
  return getErrorCode(error) === 'ENOENT'
}
