/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

function clampPositive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  if (value <= 0) return undefined
  return value
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> | undefined {
  if (typeof body !== "string") return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

function stringifyBody(body: Record<string, unknown>): string {
  return JSON.stringify(body)
}

function readTextLength(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0

  let length = 0
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue
    const text = (part as { text?: unknown }).text
    if (typeof text === "string") length += text.length
  }

  return length
}

function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 256

  let chars = 0
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue
    const content = (message as { content?: unknown }).content
    chars += readTextLength(content)
  }

  return Math.max(1, Math.ceil(chars / 4))
}

function readResponsesContentLength(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0

  let length = 0
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue
    const type = (part as { type?: unknown }).type
    if (type !== "input_text" && type !== "output_text") continue
    const text = (part as { text?: unknown }).text
    if (typeof text === "string") length += text.length
  }

  return length
}

function readResponsesInputLength(input: unknown): number {
  if (typeof input === "string") return input.length
  if (!Array.isArray(input)) return 0

  let length = 0
  for (const item of input) {
    if (typeof item !== "object" || item === null) continue
    const record = item as Record<string, unknown>
    switch (record["type"]) {
      case "message":
        length += readResponsesContentLength(record["content"])
        break
      case "function_call":
        if (typeof record["arguments"] === "string") length += record["arguments"].length
        break
      case "function_call_output":
      case "custom_tool_call_output":
        length += readResponsesContentLength(record["output"])
        break
      case "custom_tool_call":
        if (typeof record["input"] === "string") length += record["input"].length
        break
    }
  }

  return length
}

function estimateRequestedTokens(body: Record<string, unknown>): number {
  const maxTokens =
    (typeof body["max_output_tokens"] === "number" ? body["max_output_tokens"] : undefined) ??
    (typeof body["max_tokens"] === "number" ? body["max_tokens"] : undefined) ??
    (typeof body["max_completion_tokens"] === "number" ? body["max_completion_tokens"] : undefined)

  const promptTokens =
    "input" in body
      ? Math.max(
          1,
          Math.ceil(
            (readResponsesInputLength(body["input"]) +
              (typeof body["instructions"] === "string" ? body["instructions"].length : 0)) /
              4,
          ),
        )
      : estimatePromptTokens(body["messages"])
  const outputBudget = maxTokens ?? 512
  return promptTokens + outputBudget
}

function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | undefined {
  if (!value) return undefined

  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const milliseconds = seconds * 1000
    return Number.isFinite(milliseconds) ? Math.round(milliseconds) : undefined
  }

  const dateMs = Date.parse(value)
  if (Number.isNaN(dateMs)) return undefined

  const delta = dateMs - nowMs
  return delta > 0 ? delta : 0
}

function parseHeaderInt(headers: Headers, key: string): number | undefined {
  const value = headers.get(key)
  if (!value) return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return Math.floor(parsed)
}

function jitterDelay(base: number, jitterRatio: number): number {
  if (jitterRatio <= 0) return base
  const delta = Math.round(base * jitterRatio)
  const min = Math.max(0, base - delta)
  const max = base + delta
  return Math.floor(min + Math.random() * (max - min + 1))
}

function isRetryableStatus(status: number): boolean {
  return (
    status === 429 ||
    status === 408 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  )
}

function getRpmWaitMs(windowMs: number, requests: number[], now: number, rpm: number): number {
  if (requests.length < rpm) return 0
  const idx = requests.length - rpm
  const anchor = requests[idx]
  if (anchor === undefined) return 0
  return Math.max(1, windowMs - (now - anchor))
}

export {
  clampPositive,
  estimatePromptTokens,
  estimateRequestedTokens,
  getRpmWaitMs,
  isRetryableStatus,
  jitterDelay,
  parseHeaderInt,
  parseJsonBody,
  parseRetryAfterMs,
  readTextLength,
  stringifyBody,
}
