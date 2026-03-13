/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export const CAPABILITY_KEYS = {
  MAX_CONTEXT_TOKENS: [
    "maxContextToken",
    "maxContextTokens",
    "contextWindow",
    "maxInputToken",
  ] as const,
  MAX_OUTPUT_TOKENS: ["maxOutputToken", "maxOutputTokens", "maxResponseOutputTokens"] as const,
} as const

export const RATE_LIMIT_KEYS = {
  REQUEST: "request",
  TOKEN: "token",
} as const

export const CAPABILITY_FLAGS = {
  CHAT_COMPLETION: "chatCompletion",
  RESPONSES: "responses",
  EMBEDDINGS: "embeddings",
} as const

export const V1_ENDPOINTS = {
  CHAT: "/chat/completions",
  RESPONSES: "/responses",
} as const
