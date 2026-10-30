/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { waitForSignal } from "./provider-runtime"

const MAX_SANITIZE_ERROR_SCAN_CHARS = 64 * 1024
const MAX_SANITIZE_ERROR_SCAN_BYTES = 64 * 1024
const MAX_SANITIZE_ERROR_PROBE_MS = 1000

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

  let sanitized: unknown[] | undefined
  for (let index = 0; index < messages.length; index += 1) {
    const message: unknown = messages[index]
    if (typeof message !== "object" || message === null) {
      sanitized?.push(message)
      continue
    }

    const role = (message as { role?: unknown }).role
    const record = message as Record<string, unknown>
    if (
      role !== "assistant" ||
      (!Object.prototype.hasOwnProperty.call(record, "reasoning_content") &&
        !Object.prototype.hasOwnProperty.call(record, "reasoning"))
    ) {
      sanitized?.push(message)
      continue
    }

    const { reasoning_content: _reasoningContent, reasoning: _reasoning, ...rest } = record
    sanitized ??= messages.slice(0, index)
    sanitized.push(rest)
  }

  return sanitized ?? messages
}

function sanitizeBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!("messages" in body)) return body

  const messages = sanitizeChatMessages(body["messages"])
  if (messages === body["messages"]) return body
  return { ...body, messages }
}

async function readBoundedErrorBody(
  response: Response,
  callerSignal: AbortSignal | undefined,
): Promise<string | undefined> {
  const controller = new AbortController()
  const onCallerAbort = () => {
    controller.abort(callerSignal?.reason)
  }
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true })
  if (callerSignal?.aborted) onCallerAbort()
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Error-body probe timed out", "TimeoutError"))
  }, MAX_SANITIZE_ERROR_PROBE_MS)

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let completed = false
  try {
    const body = response.clone().body
    if (!body) return undefined

    reader = body.getReader()
    const decoder = new TextDecoder()
    let bytes = 0
    let text = ""
    while (true) {
      const chunk = await waitForSignal(reader.read(), controller.signal)
      if (chunk.done) {
        completed = true
        return text + decoder.decode()
      }

      bytes += chunk.value.byteLength
      if (bytes > MAX_SANITIZE_ERROR_SCAN_BYTES) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
    callerSignal?.removeEventListener("abort", onCallerAbort)
    if (reader) {
      if (completed) {
        reader.releaseLock()
      } else {
        void reader
          .cancel()
          .catch(() => {})
          .finally(() => {
            try {
              reader?.releaseLock()
            } catch {
              // A pending read releases its lock when it settles.
            }
          })
      }
    }
  }
}

async function shouldRetryWithSanitizedBody(
  response: Response,
  callerSignal?: AbortSignal,
): Promise<boolean> {
  if (response.status !== 400 || callerSignal?.aborted) return false

  const body = await readBoundedErrorBody(response, callerSignal)
  if (body === undefined) return false

  try {
    const json: unknown = JSON.parse(body)
    const text = typeof json === "string" ? json : JSON.stringify(json)
    if (text.length > MAX_SANITIZE_ERROR_SCAN_CHARS) return false

    const normalized = text.toLowerCase()
    return hasReasoningSignal(normalized) && hasSchemaLikeSignal(normalized)
  } catch {
    return false
  }
}

export { sanitizeBody, sanitizeChatMessages, shouldRetryWithSanitizedBody }
