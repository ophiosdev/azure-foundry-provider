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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function dropParallelToolCalls(
  providerOptions: ProviderLanguageModelCallOptions["providerOptions"],
): ProviderLanguageModelCallOptions["providerOptions"] {
  if (!providerOptions) return undefined

  const openaiOptions = providerOptions["openai"]
  if (!isRecord(openaiOptions)) return providerOptions

  if (!Object.prototype.hasOwnProperty.call(openaiOptions, "parallelToolCalls")) {
    return providerOptions
  }

  const { parallelToolCalls: _ignored, ...openaiRest } = openaiOptions
  const entries = Object.entries(providerOptions).filter(([key]) => key !== "openai")
  if (Object.keys(openaiRest).length > 0) {
    entries.push(["openai", openaiRest])
  }

  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

function stripTools(options: ProviderLanguageModelCallOptions): ProviderLanguageModelCallOptions {
  const providerOptions = dropParallelToolCalls(options.providerOptions)
  const { providerOptions: _providerOptions, ...rest } = options

  return {
    ...rest,
    tools: [],
    toolChoice: { type: "none" },
    ...(providerOptions ? { providerOptions } : {}),
  }
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
  if (policy.toolPolicy === "off") {
    return stripTools(options)
  }

  if (policy.toolPolicy === "on") {
    return enforceTools(options)
  }

  return options
}

export function applyRequestPolicy<MODEL extends ProviderLanguageModel>(
  model: MODEL,
  policy: PolicyOptions,
): MODEL {
  if (policy.mode !== "chat" && policy.toolPolicy === "auto") return model

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
