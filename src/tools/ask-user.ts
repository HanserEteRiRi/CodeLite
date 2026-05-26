import { z } from 'zod'
import type { ToolDefinition } from '../tool.js'

type Input = {
  question: string
}

export const askUserTool: ToolDefinition<Input> = {
  name: 'ask_user',
  description:
    'Ask the user a clarifying question and stop the current turn until the user replies.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
    },
    required: ['question'],
  },
  schema: z.object({
    question: z.string().min(1),
  }),
  // 向用户提问并返回用户的回复，同时暂停当前对话轮次
  // Ask the user a clarifying question and pause the current turn
  async run(input) {
    const question = input.question.trim()
    return {
      ok: true,
      output: question,
      awaitUser: true,
    }
  },
}
