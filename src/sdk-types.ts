/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
} from "@ai-sdk/provider"

export type ProviderLanguageModel = LanguageModelV3
export type ProviderTransportLanguageModel = LanguageModelV4
export type ProviderTransportCallOptions = LanguageModelV4CallOptions
export type ProviderTransportMiddleware = LanguageModelV4Middleware
export type ProviderLanguageModelCallOptions = LanguageModelV3CallOptions
export type ProviderEmbeddingModel = EmbeddingModelV2<string>
export type ProviderImageModel = ImageModelV2
