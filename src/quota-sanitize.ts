const MAX_SANITIZE_ERROR_SCAN_CHARS = 64 * 1024

function hasSchemaLikeSignal(text: string): boolean {
  return (
    text.includes("extra_forbidden") ||
    text.includes("additional properties") ||
    text.includes("extra inputs are not permitted") ||
    text.includes("invalid input")
  )
}

function hasReasoningSignal(text: string): boolean {
  return text.includes("reasoning_content") || text.includes('"reasoning"')
}

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
      if (typeof json === "string") {
        if (json.length > MAX_SANITIZE_ERROR_SCAN_CHARS) return false
        const text = json.toLowerCase()
        return hasReasoningSignal(text) && hasSchemaLikeSignal(text)
      }

      const text = JSON.stringify(json)
      if (text.length > MAX_SANITIZE_ERROR_SCAN_CHARS) return false

      const lower = text.toLowerCase()
      return hasReasoningSignal(lower) && hasSchemaLikeSignal(lower)
    })
    .catch(() => false)
}

export { sanitizeBody, sanitizeChatMessages, shouldRetryWithSanitizedBody }
