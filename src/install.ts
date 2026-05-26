import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  CODE_LITE_SETTINGS_PATH,
  loadEffectiveSettings,
  saveCodeLiteSettings,
} from './config.js'

// 检查目标目录是否已在 PATH 环境变量中
// Checks whether the target directory is already in the PATH environment variable
function hasPathEntry(target: string): boolean {
  const pathEntries = (process.env.PATH ?? '').split(':')
  return pathEntries.includes(target)
}

// 循环询问用户输入必填项，直到用户输入非空值为止
// Loops until the user provides a non-empty value for a required configuration field
async function askRequired(
  nextLine: () => Promise<string | null>,
  label: string,
  defaultValue?: string,
): Promise<string> {
  while (true) {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    process.stdout.write(`${label}${suffix}: `)
    const incoming = await nextLine()
    const answer = (incoming ?? '').trim()
    const value = answer || defaultValue || ''
    if (value) return value
    console.log('该项不能为空，请重新输入。')
  }
}

// 根据密钥是否已保存返回对应的提示后缀文本
// Returns a prompt suffix indicating whether a secret value is already saved
function secretPromptSuffix(secret?: string): string {
  if (!secret) return ' [not set]'
  return ' [saved]'
}

// 安装引导：收集模型和认证配置，写入 settings.json，创建启动脚本
// Installation wizard: collects model and auth config, writes settings.json, creates launcher script
async function main(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  try {
    const iterator = rl[Symbol.asyncIterator]()
    const nextLine = async (): Promise<string | null> => {
      const result = await iterator.next()
      return result.done ? null : result.value
    }

    const settings = await loadEffectiveSettings()
    const currentEnv = settings.env ?? {}

    console.log('code-lite installer')
    console.log(`配置会写入 ${CODE_LITE_SETTINGS_PATH}`)
    console.log('配置保存在独立目录中，不会影响其它本地工具配置。')
    console.log('')

    const model = await askRequired(
      nextLine,
      'Model name',
      settings.model ? String(settings.model) : String(currentEnv.ANTHROPIC_MODEL ?? ''),
    )
    const baseUrl = await askRequired(
      nextLine,
      'ANTHROPIC_BASE_URL',
      String(currentEnv.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com'),
    )
    const savedAuthToken = String(currentEnv.ANTHROPIC_AUTH_TOKEN ?? '')
    process.stdout.write(`ANTHROPIC_AUTH_TOKEN${secretPromptSuffix(savedAuthToken)}: `)
    const tokenInput = ((await nextLine()) ?? '').trim()
    const authToken = tokenInput || savedAuthToken

    if (!authToken) {
      throw new Error('ANTHROPIC_AUTH_TOKEN 不能为空。')
    }

    await saveCodeLiteSettings({
      model,
      env: {
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: authToken,
        ANTHROPIC_MODEL: model,
      },
    })

    const home = os.homedir()
    const targetBinDir = process.env.CODE_LITE_BIN_DIR
      ? path.resolve(process.env.CODE_LITE_BIN_DIR)
      : path.join(home, '.local', 'bin')
    const launcherPath = path.join(targetBinDir, 'codelite')
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const launcherScript = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `exec "${path.join(repoRoot, 'bin', 'codelite')}" "$@"`,
      '',
    ].join('\n')

    await mkdir(targetBinDir, { recursive: true })
    await writeFile(launcherPath, launcherScript, { mode: 0o755 })

    console.log('')
    console.log('安装完成。')
    console.log(`配置文件: ${CODE_LITE_SETTINGS_PATH}`)
    console.log(`启动命令: ${launcherPath}`)

    if (!hasPathEntry(targetBinDir)) {
      console.log('')
      console.log(`你的 PATH 里还没有 ${targetBinDir}`)
      console.log(`可以把下面这行加入 ~/.bashrc 或 ~/.zshrc:`)
      console.log(`export PATH="${targetBinDir}:$PATH"`)
    } else {
      console.log('')
      console.log('现在你可以在任意终端输入 `codelite` 启动。')
    }
  } finally {
    rl.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
