import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { CODE_LITE_DIR, CODE_LITE_HISTORY_PATH } from './config.js'

type HistoryEntry = {
  display: string
  timestamp: number
  project: string
  sessionId: string
}

const MAX_ENTRIES = 500

// 从 JSONL 文件加载历史输入记录，返回去重后的条目列表
// Loads input history entries from the JSONL file, returning deduplicated entries
export async function loadHistoryEntries(): Promise<string[]> {
  try {
    const raw = await readFile(CODE_LITE_HISTORY_PATH, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const entries: string[] = []
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as HistoryEntry
        if (typeof entry.display === 'string') {
          entries.push(entry.display)
        }
      } catch {
        // skip malformed lines
      }
    }
    return entries
  } catch {
    return []
  }
}

// 保存新的历史输入记录，自动去重并裁剪至最大条目数
// Saves new input history entries, deduplicating and trimming to the max entry limit
export async function saveHistoryEntries(
  entries: string[],
  cwd: string,
  sessionId: string,
): Promise<void> {
  await mkdir(CODE_LITE_DIR, { recursive: true })

  const existing = await loadHistoryEntries()
  // Find which entries are new
  const existingSet = new Set(existing)
  const newEntries = entries.filter(e => !existingSet.has(e))

  if (newEntries.length === 0) return

  const now = Date.now()
  const lines = newEntries.map(display =>
    JSON.stringify({ display, timestamp: now, project: cwd, sessionId }),
  )

  await appendFile(CODE_LITE_HISTORY_PATH, lines.join('\n') + '\n', 'utf8')

  // Trim to MAX_ENTRIES if needed
  try {
    const raw = await readFile(CODE_LITE_HISTORY_PATH, 'utf8')
    const allLines = raw.trim().split('\n').filter(Boolean)
    if (allLines.length > MAX_ENTRIES) {
      const { writeFile } = await import('node:fs/promises')
      const kept = allLines.slice(-MAX_ENTRIES)
      await writeFile(
        CODE_LITE_HISTORY_PATH,
        kept.join('\n') + '\n',
        'utf8',
      )
    }
  } catch {
    // ignore trim errors
  }
}
