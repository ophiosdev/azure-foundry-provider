/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { wrapLanguageModel } from "ai"
import type {
  ProviderLanguageModel,
  ProviderLanguageModelCallOptions,
  ProviderLanguageModelMiddleware,
} from "./sdk-types"
import type { ApiMode } from "./url"

export type ToolPolicy = "auto" | "off" | "on"

type PolicyOptions = {
  mode: ApiMode
  toolPolicy: ToolPolicy
  providerName?: string
}

const FACTORY_OPTION_KEYS = new Set([
  "endpoint",
  "apiKey",
  "headers",
  "apiMode",
  "toolPolicy",
  "timeout",
  "quota",
  "cooldownScope",
  "assistantReasoningSanitization",
  "modelOptions",
  "onRetry",
  "onAdaptiveCooldown",
  "onSanitizedRetry",
  "onFallback",
  "fetch",
  "name",
  "bearerToken",
  "bearerTokenProvider",
  "entraId",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function dropParallelToolCalls(
  providerOptions: ProviderLanguageModelCallOptions["providerOptions"],
  policy: PolicyOptions,
): ProviderLanguageModelCallOptions["providerOptions"] {
  if (!providerOptions) return undefined

  const normalizedName = policy.providerName?.toLowerCase()
  const namespace =
    policy.mode === "responses"
      ? normalizedName?.includes("azure")
        ? "azure"
        : "openai"
      : policy.providerName
  const keys = new Set(["openai", namespace].filter((key): key is string => key !== undefined))
  let next: Record<string, unknown> | undefined
  for (const key of keys) {
    const value = providerOptions[key]
    if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "parallelToolCalls"))
      continue
    next ??= { ...providerOptions }
    const { parallelToolCalls: _ignored, ...rest } = value
    if (Object.keys(rest).length > 0) next[key] = rest
    else delete next[key]
  }

  return (
    (next as ProviderLanguageModelCallOptions["providerOptions"] | undefined) ?? providerOptions
  )
}

function stripTools(
  options: ProviderLanguageModelCallOptions,
  policy: PolicyOptions,
): ProviderLanguageModelCallOptions {
  const providerOptions = dropParallelToolCalls(options.providerOptions, policy)
  const { providerOptions: _providerOptions, ...rest } = options

  return {
    ...rest,
    tools: [],
    toolChoice: { type: "none" },
    ...(providerOptions ? { providerOptions } : {}),
  }
}

function normalizeProviderOptions(
  providerOptions: ProviderLanguageModelCallOptions["providerOptions"],
  policy: PolicyOptions,
): ProviderLanguageModelCallOptions["providerOptions"] {
  const providerName = policy.providerName
  if (!providerOptions || !providerName) return providerOptions

  const configuredOptions = providerOptions[providerName]
  if (!isRecord(configuredOptions)) return providerOptions

  const entries = Object.entries(configuredOptions).filter(([key]) => !FACTORY_OPTION_KEYS.has(key))
  if (policy.mode === "chat" && entries.length === Object.keys(configuredOptions).length)
    return providerOptions

  const requestOptions = Object.fromEntries(entries)
  const targetName =
    policy.mode === "responses"
      ? providerName.toLowerCase().includes("azure")
        ? "azure"
        : "openai"
      : providerName

  if (targetName === providerName) {
    const next = { ...providerOptions }
    if (entries.length > 0) next[providerName] = requestOptions
    else delete next[providerName]
    return next
  }

  const existing = providerOptions[targetName]
  const normalized = {
    ...requestOptions,
    ...(isRecord(existing) ? existing : {}),
  }
  const next = { ...providerOptions }
  delete next[providerName]
  if (Object.keys(normalized).length > 0) next[targetName] = normalized
  else delete next[targetName]
  return next
}

function enforceTools(options: ProviderLanguageModelCallOptions): ProviderLanguageModelCallOptions {
  if (!options.tools || options.tools.length === 0) return options
  if (options.toolChoice?.type === "required") return options
  if (options.toolChoice?.type === "tool") return options

  return {
    ...options,
    toolChoice: { type: "required" },
  }
}

function transform(
  options: ProviderLanguageModelCallOptions,
  policy: PolicyOptions,
): ProviderLanguageModelCallOptions {
  const providerOptions = normalizeProviderOptions(options.providerOptions, policy)
  const normalized =
    providerOptions === options.providerOptions || providerOptions === undefined
      ? options
      : { ...options, providerOptions }

  if (policy.toolPolicy === "off") {
    return stripTools(normalized, policy)
  }

  if (policy.toolPolicy === "on") {
    return enforceTools(normalized)
  }

  return normalized
}

export function applyRequestPolicy<MODEL extends ProviderLanguageModel>(
  model: MODEL,
  policy: PolicyOptions,
): MODEL {
  if (policy.mode !== "chat" && policy.toolPolicy === "auto" && !policy.providerName) return model

  const middleware: ProviderLanguageModelMiddleware = {
    specificationVersion: "v3",
    async transformParams({ params }: { params: ProviderLanguageModelCallOptions }) {
      return Promise.resolve(transform(params, policy))
    },
  }

  return wrapLanguageModel({
    model,
    middleware,
  }) as MODEL
}
