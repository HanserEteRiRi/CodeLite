import process from 'node:process'

const ENTER_ALT_SCREEN = '[?1049h'
const EXIT_ALT_SCREEN = '[?1049l'
const ERASE_SCREEN_AND_HOME = '[2J[H'
const ENABLE_MOUSE_TRACKING =
  '[?1000h' +
  '[?1002h' +
  '[?1006h'
const DISABLE_MOUSE_TRACKING =
  '[?1006l' +
  '[?1002l' +
  '[?1000l'
// 隐藏终端光标
// Hide the terminal cursor
export function hideCursor(): void {
  process.stdout.write('[?25l')
}

// 显示终端光标
// Show the terminal cursor
export function showCursor(): void {
  process.stdout.write('[?25h')
}

// 进入备用屏幕缓冲区，启用鼠标追踪
// Enter the alternate screen buffer and enable mouse tracking
export function enterAlternateScreen(): void {
  process.stdout.write(
    DISABLE_MOUSE_TRACKING + ENTER_ALT_SCREEN + ERASE_SCREEN_AND_HOME + ENABLE_MOUSE_TRACKING,
  )
}

// 退出备用屏幕缓冲区，禁用鼠标追踪
// Exit the alternate screen buffer and disable mouse tracking
export function exitAlternateScreen(): void {
  process.stdout.write(DISABLE_MOUSE_TRACKING + EXIT_ALT_SCREEN)
}

// 清除屏幕内容并将光标移到原点（软重绘以减少闪烁）
// Clear the screen and move cursor to home (softer redraw to reduce flicker)
export function clearScreen(): void {
  // Softer redraw than full clear to reduce visible flicker.
  process.stdout.write('[H[J')
}
