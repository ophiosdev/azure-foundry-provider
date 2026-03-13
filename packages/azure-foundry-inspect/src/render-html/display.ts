/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { RATE_LIMIT_KEYS } from "../constants"
import { parseNumeric } from "../utils"
import { escapeHtml } from "./html-escape"

export function formatCompactCount(value: unknown): string {
  const count = parseNumeric(value)
  if (typeof count !== "number") return ""
  if (Math.abs(count) < 1000) return String(count)
  const compact = count / 1000
  const rounded = Number.isInteger(compact) ? String(compact) : String(Number(compact.toFixed(1)))
  return `${rounded}k`
}

export function rateLimitCount(rateLimits: readonly unknown[], key: string): number | undefined {
  for (const entry of rateLimits) {
    const item = typeof entry === "object" && entry ? (entry as Record<string, unknown>) : undefined
    if (item?.["key"] === key) return parseNumeric(item["count"])
  }
  return undefined
}

export interface RateLimitRow {
  keyHtml: string
  countDisplay: string
  countTitle: string
  renewalDisplay: string
  renewalTitle: string
}

export function buildRateLimitRows(rateLimits: readonly unknown[]): RateLimitRow[] {
  return rateLimits.map((entry) => {
    const item = typeof entry === "object" && entry ? (entry as Record<string, unknown>) : {}
    const key = item["key"]
    const count = item["count"]
    const renewal = item["renewalPeriod"]
    const renewalText = parseNumeric(renewal)
    const renewalDisplayValue = typeof renewalText === "number" ? String(renewalText) : ""
    return {
      keyHtml:
        key === RATE_LIMIT_KEYS.REQUEST
          ? '<abbr title="Requests per minute">RPM</abbr>'
          : key === RATE_LIMIT_KEYS.TOKEN
            ? '<abbr title="Tokens per minute">TPM</abbr>'
            : escapeHtml(key ?? ""),
      countDisplay: formatCompactCount(count),
      countTitle:
        key === RATE_LIMIT_KEYS.REQUEST
          ? `RPM: about ${formatCompactCount(count)} requests per ${renewalDisplayValue} seconds.`
          : key === RATE_LIMIT_KEYS.TOKEN
            ? `TPM: about ${formatCompactCount(count)} tokens per ${renewalDisplayValue} seconds.`
            : "",
      renewalDisplay: typeof renewalText === "number" ? `${String(renewalText)}s` : "",
      renewalTitle:
        typeof renewalText === "number"
          ? `Window resets every ${String(renewalText)} seconds.`
          : "",
    }
  })
}
