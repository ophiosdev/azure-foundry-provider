/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { createAzureFoundryProvider } from "./provider"

export { createAzureFoundryProvider } from "./provider"
export type {
  AzureFoundryOptions,
  AzureFoundryProvider,
  EntraIdOptions,
  TokenCredential,
} from "./provider"

export { parseEndpoint } from "./url"
export type { ApiMode, HostType, ParsedEndpoint, PathType } from "./url"

export type { ToolPolicy } from "./request"
export type {
  AdaptiveCooldownEvent,
  AssistantReasoningSanitizationPolicy,
  ModelRequestOptions,
  QuotaAdaptiveOptions,
  QuotaOptions,
  QuotaRetryOptions,
  QuotaRule,
  RetryEvent,
  RequestPolicyOptions,
  SanitizedRetryEvent,
} from "./quota"

export const azureFoundryProvider = createAzureFoundryProvider()
