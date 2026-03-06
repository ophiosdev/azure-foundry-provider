/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

const MAX_FALLBACK_RESPONSE_BODY_PARSE_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function extractStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined

  const candidates = [error["status"], error["statusCode"]]
  const response = error["response"]
  if (isRecord(response)) candidates.push(response["status"])

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate
  }

  return undefined
}

function addString(candidates: string[], value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    candidates.push(value)
  }
}

function shouldParseResponseBody(responseBody: string): boolean {
  if (responseBody.length > MAX_FALLBACK_RESPONSE_BODY_PARSE_BYTES) return false

  const trimmed = responseBody.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false

  const lower = trimmed.toLowerCase()
  return (
    lower.includes("error") ||
    lower.includes("message") ||
    lower.includes("code") ||
    lower.includes("detail") ||
    lower.includes("operation")
  )
}

function hasChatOperationContext(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes("chatcompletion") ||
    lower.includes("chat completions") ||
    lower.includes("/chat/completions") ||
    lower.includes("chat_completions")
  )
}

function extractStructuredMismatchSignals(error: unknown): {
  operationNotSupported: boolean
  chatContext: boolean
} {
  if (!isRecord(error)) {
    return { operationNotSupported: false, chatContext: false }
  }

  let operationNotSupported = false
  let chatContext = false

  const inspectRecord = (record: Record<string, unknown>) => {
    const code = record["code"]
    if (typeof code === "string" && code.toLowerCase() === "operation_not_supported") {
      operationNotSupported = true
    }

    const operation = record["operation"]
    if (typeof operation === "string" && hasChatOperationContext(operation)) {
      chatContext = true
    }

    const target = record["target"]
    if (typeof target === "string" && hasChatOperationContext(target)) {
      chatContext = true
    }

    const param = record["param"]
    if (typeof param === "string" && hasChatOperationContext(param)) {
      chatContext = true
    }

    const path = record["path"]
    if (typeof path === "string" && hasChatOperationContext(path)) {
      chatContext = true
    }

    const loc = record["loc"]
    if (Array.isArray(loc)) {
      for (const segment of loc) {
        if (typeof segment === "string" && hasChatOperationContext(segment)) {
          chatContext = true
          break
        }
      }
    }
  }

  inspectRecord(error)

  const nestedError = error["error"]
  if (isRecord(nestedError)) {
    inspectRecord(nestedError)
  }

  const data = error["data"]
  if (isRecord(data)) {
    inspectRecord(data)

    const dataError = data["error"]
    if (isRecord(dataError)) {
      inspectRecord(dataError)
    }

    const detail = data["detail"]
    if (Array.isArray(detail)) {
      for (const item of detail) {
        if (!isRecord(item)) continue
        inspectRecord(item)
      }
    }
  }

  const detail = error["detail"]
  if (Array.isArray(detail)) {
    for (const item of detail) {
      if (!isRecord(item)) continue
      inspectRecord(item)
    }
  }

  return {
    operationNotSupported,
    chatContext,
  }
}

function extractErrorTextCandidates(error: unknown): string[] {
  if (!isRecord(error)) return []

  const candidates: string[] = []
  addString(candidates, error["message"])
  addString(candidates, error["code"])

  const nestedError = error["error"]
  if (isRecord(nestedError)) {
    addString(candidates, nestedError["message"])
    addString(candidates, nestedError["code"])
    addString(candidates, nestedError["type"])
  }

  const data = error["data"]
  if (isRecord(data)) {
    addString(candidates, data["message"])
    addString(candidates, data["code"])

    const dataError = data["error"]
    if (isRecord(dataError)) {
      addString(candidates, dataError["message"])
      addString(candidates, dataError["code"])
      addString(candidates, dataError["type"])
    }

    const detail = data["detail"]
    if (Array.isArray(detail)) {
      for (const item of detail) {
        if (!isRecord(item)) continue
        addString(candidates, item["message"])
        addString(candidates, item["msg"])
        addString(candidates, item["type"])
      }
    }
  }

  const responseBody = error["responseBody"]
  if (typeof responseBody === "string") {
    addString(candidates, responseBody)
    if (shouldParseResponseBody(responseBody)) {
      try {
        const parsed: unknown = JSON.parse(responseBody)
        if (isRecord(parsed)) {
          addString(candidates, parsed["message"])
          addString(candidates, parsed["code"])
          const parsedError = parsed["error"]
          if (isRecord(parsedError)) {
            addString(candidates, parsedError["message"])
            addString(candidates, parsedError["code"])
            addString(candidates, parsedError["type"])
          }
        }
      } catch {
        // ignore invalid JSON response body
      }
    }
  }

  return candidates
}

function hasChatOperationMismatchText(text: string): boolean {
  const lower = text.toLowerCase()
  if (lower.includes("content_filter")) return false

  const chatOperationMentioned =
    lower.includes("chatcompletion operation") ||
    lower.includes("chat completions operation") ||
    hasChatOperationContext(lower)

  const unsupportedMentioned =
    lower.includes("does not work") ||
    lower.includes("not supported") ||
    lower.includes("unsupported") ||
    lower.includes("not available") ||
    lower.includes("operation_not_supported")

  return chatOperationMentioned && unsupportedMentioned
}

function isChatOperationMismatchError(error: unknown): boolean {
  const status = extractStatusCode(error)
  if (status !== undefined && status !== 400) return false

  const structured = extractStructuredMismatchSignals(error)
  if (structured.operationNotSupported && structured.chatContext) {
    return true
  }

  const candidates = extractErrorTextCandidates(error)
  return candidates.some((candidate) => hasChatOperationMismatchText(candidate))
}

export { extractStructuredMismatchSignals, isChatOperationMismatchError, shouldParseResponseBody }
