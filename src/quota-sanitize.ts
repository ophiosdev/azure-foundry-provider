function sanitizeChatMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages

  return messages.map((message): unknown => {
    if (typeof message !== "object" || message === null) return message

    const role = (message as { role?: unknown }).role
    if (role !== "assistant") return message

    const {
      reasoning_content: _reasoningContent,
      reasoning: _reasoning,
      ...rest
    } = message as Record<string, unknown>
    return rest
  })
}

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!("messages" in body)) return body

  return {
    ...body,
    messages: sanitizeChatMessages(body["messages"]),
  }
}

function shouldRetryWithSanitizedBody(response: Response): Promise<boolean> {
  if (response.status !== 400) return Promise.resolve(false)

  return response
    .clone()
    .json()
    .then((json) => {
      const text = JSON.stringify(json).toLowerCase()
      const hasReasoningField = text.includes("reasoning_content") || text.includes('"reasoning"')
      const schemaLike =
        text.includes("extra_forbidden") ||
        text.includes("additional properties") ||
        text.includes("extra inputs are not permitted") ||
        text.includes("invalid input")
      return hasReasoningField && schemaLike
    })
    .catch(() => false)
}

export { sanitizeBody, sanitizeChatMessages, shouldRetryWithSanitizedBody }
