/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { prettyPrintJson } from "pretty-print-json"
import { v1BaseUrl, preferredEndpoint } from "./endpoints"
import { rateLimitCount } from "./display"
import type { DeploymentOut } from "../types"

export interface ProviderConfigViewModel {
  dialogId: string
  rawJson: string
  prettyHtml: string
}

export function providerConfigObject(
  accountName: string,
  deployment: DeploymentOut,
): object | undefined {
  if (!deployment.name) return undefined
  const preferred = preferredEndpoint(accountName, deployment)
  if (!preferred) return undefined

  const rpm = rateLimitCount(deployment.deployment?.rateLimits ?? [], "request")
  const tpm = rateLimitCount(deployment.deployment?.rateLimits ?? [], "token")

  return {
    provider: {
      "azure-foundry": {
        name: "Azure Foundry",
        npm: "file:///usr/local/provider/azure-foundry-provider/index.js",
        models: {
          [deployment.model.name ?? deployment.name]: {
            id: deployment.name,
            name: deployment.model.name ?? deployment.name,
            modalities: {
              input: ["text"],
              output: ["text"],
            },
          },
        },
        options: {
          endpoint: v1BaseUrl(accountName),
          apiKey: "{env:AZURE_API_KEY}",
          modelOptions: {
            [deployment.name]: {
              apiMode: preferred.apiMode,
            },
          },
          quota: {
            models: {
              [deployment.name]: {
                ...(typeof rpm === "number" ? { rpm } : {}),
                ...(typeof tpm === "number" ? { tpm } : {}),
              },
            },
          },
        },
      },
    },
  }
}

export function buildProviderConfig(
  accountName: string,
  deployment: DeploymentOut,
  index: number,
): ProviderConfigViewModel | undefined {
  const object = providerConfigObject(accountName, deployment)
  if (!object) return undefined
  const raw = JSON.stringify(object, null, 2)
  return {
    dialogId: `provider-config-${String(index)}`,
    rawJson: raw,
    prettyHtml: prettyPrintJson.toHtml(object, {
      linkUrls: false,
      quoteKeys: true,
      trailingCommas: false,
    }),
  }
}
