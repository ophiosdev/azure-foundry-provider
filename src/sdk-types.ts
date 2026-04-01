/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type {
  EmbeddingModelV2,
  ImageModelV2,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Middleware,
} from "@ai-sdk/provider"

export type ProviderLanguageModel = LanguageModelV3
export type ProviderLanguageModelCallOptions = LanguageModelV3CallOptions
export type ProviderLanguageModelMiddleware = LanguageModelV3Middleware
export type ProviderEmbeddingModel = EmbeddingModelV2<string>
export type ProviderImageModel = ImageModelV2
