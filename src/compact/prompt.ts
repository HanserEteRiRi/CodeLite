// 构建发送给 LLM 的对话压缩总结提示词
// Build the conversation compact summary prompt sent to the LLM
export function buildCompactSummaryPrompt(conversationText: string): string {
  return `You are summarizing a conversation for context compression.
Produce a structured summary in <summary> tags.

Sections:
1. Primary Request — What the user asked for
2. Key Decisions — Important choices made
3. Files Modified — Which files were changed and why
4. Errors Encountered — Problems hit and how they were resolved
5. Current State — Where things stand right now
6. Pending Tasks — What still needs to be done

Rules:
- Be concise but preserve actionable details (file paths, command outputs, error messages)
- Use <analysis> tags as scratchpad, then <summary> tags for final output
- The summary will replace all messages before the recent tail

Conversation to summarize:

${conversationText}`
}

// 从 LLM 响应中提取 <summary> 标签内的内容；回退到纯文本
// Extract content inside <summary> tags from the LLM response; fall back to plain text
export function parseSummaryFromResponse(response: string): string | null {
  const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim()
  }

  const analysisMatch = response.match(/<analysis>([\s\S]*?)<\/analysis>/)
  if (!analysisMatch) {
    const trimmed = response.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }

  return null
}
