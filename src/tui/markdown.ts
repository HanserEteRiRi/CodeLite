const RESET = '\u001b[0m'
const DIM = '\u001b[2m'
const CYAN = '\u001b[36m'
const YELLOW = '\u001b[33m'
const MAGENTA = '\u001b[35m'
const BOLD = '\u001b[1m'

// 将 Markdown 风格的文本渲染为 ANSI 转义格式：标题、代码块、表格、列表、引用等
// Render Markdown-ish text into ANSI escape sequences: headers, code blocks, tables, lists, blockquotes, etc.
export function renderMarkdownish(input: string): string {
  const lines = input.split('\n')
  let inCodeBlock = false

  return lines
    .map(line => {
      let formatted = line

      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock
        return `${DIM}${line}${RESET}`
      }

      if (inCodeBlock) {
        return `${DIM}${line}${RESET}`
      }

      if (/^\|(?:\s*:?-+:?\s*\|)+$/.test(line.trim())) {
        return `${DIM}${line.replace(/\|/g, ' ').trim()}${RESET}`
      }

      if (/^\|.*\|$/.test(line.trim())) {
        const cells = line
          .split('|')
          .map(cell => cell.trim())
          .filter(Boolean)
        return cells.join(` ${DIM}|${RESET} `)
      }

      if (line.startsWith('### ')) {
        return `${CYAN}${BOLD}${line.slice(4)}${RESET}`
      }

      if (line.startsWith('## ')) {
        return `${CYAN}${BOLD}${line.slice(3)}${RESET}`
      }

      if (line.startsWith('# ')) {
        return `${CYAN}${BOLD}${line.slice(2)}${RESET}`
      }

      if (line.startsWith('> ')) {
        return `${DIM}${line}${RESET}`
      }

      if (/^\s*[-*]\s+/.test(line)) {
        formatted = line.replace(/^\s*[-*]\s+/, `${YELLOW}•${RESET} `)
      }

      formatted = formatted.replace(/`([^`]+)`/g, `${MAGENTA}$1${RESET}`)
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, `${BOLD}$1${RESET}`)

      return formatted
    })
    .join('\n')
}
