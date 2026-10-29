/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { AzureFoundryOptions, AzureFoundryProvider } from "../src/provider"

const moduleURL = new URL("../dist/index.js", import.meta.url).href
type ProviderModule = Record<string, unknown> & {
  createAzureFoundryProvider?: (options?: AzureFoundryOptions) => AzureFoundryProvider
}
const providerModule = (await import(moduleURL)) as ProviderModule
const factories = Object.keys(providerModule).filter((name) => name.startsWith("create"))

if (factories.length !== 1 || factories[0] !== "createAzureFoundryProvider") {
  throw new Error(`Expected only createAzureFoundryProvider, got: ${factories.join(", ")}`)
}

const factory = providerModule.createAzureFoundryProvider
if (!factory) throw new Error("Compiled provider factory export is missing")

const provider = factory({
  endpoint: "https://example.services.ai.azure.com/openai/v1/chat/completions",
  apiKey: "artifact-smoke-test",
  name: "azure-foundry",
})
const model = provider.languageModel("gpt-5.4")

if (model.specificationVersion !== "v3" || model.modelId !== "gpt-5.4") {
  throw new Error("Compiled provider did not construct the expected V3 model")
}

console.log("Compiled provider factory loaded from file URL and constructed V3 model")
