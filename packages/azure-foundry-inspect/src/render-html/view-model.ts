/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { Output, RateLimitsOutput } from "../types"
import { v1BaseUrl, inferV1Endpoints, isFullDeployment } from "./endpoints"
import { buildProviderConfig } from "./provider-config"
import { buildRateLimitRows } from "./display"

export type HtmlReportViewModel = {
  page: {
    title: string
    accountName: string
  }
  summaryRows: Array<{ label: string; value: string | number }>
  deployments: Array<{
    title: string
    chips: string[]
    badges: string[]
    limits: Array<{ label: string; value: string | number; title: string }>
    details: Array<{ label: string; valueText?: string; valueHtml?: string; wide?: boolean }>
    rateLimits: Array<{
      keyHtml: string
      countDisplay: string
      countTitle: string
      renewalDisplay: string
      renewalTitle: string
    }>
    capabilities: Array<{ key: string; value: string }>
    providerConfig?:
      | {
          dialogId: string
          rawJson: string
          prettyHtml: string
        }
      | undefined
  }>
}

export function buildHtmlReportViewModel(data: Output | RateLimitsOutput): HtmlReportViewModel {
  return {
    page: {
      title: `Azure Foundry Inspect - ${data.resource.accountName}`,
      accountName: data.resource.accountName,
    },
    summaryRows: [
      { label: "Subscription", value: data.resource.subscriptionId },
      { label: "Resource group", value: data.resource.resourceGroup },
      ...(data.resource.accountId ? [{ label: "Account ID", value: data.resource.accountId }] : []),
      ...(data.resource.location ? [{ label: "Location", value: data.resource.location }] : []),
      ...(data.resource.kind ? [{ label: "Kind", value: data.resource.kind }] : []),
      ...(data.resource.sku?.name ? [{ label: "SKU", value: data.resource.sku.name }] : []),
      ...(data.resource.sku?.tier ? [{ label: "Tier", value: data.resource.sku.tier }] : []),
      { label: "Deployments", value: data.deployments.length },
    ],
    deployments: data.deployments.map((deployment, index) => {
      const full = isFullDeployment(deployment)
      const rateLimits = full ? (deployment.deployment?.rateLimits ?? []) : deployment.rateLimits
      const endpointRows = full
        ? inferV1Endpoints(deployment.capabilities).map(
            (endpoint) => `${v1BaseUrl(data.resource.accountName)}${endpoint}`,
          )
        : []
      const card: HtmlReportViewModel["deployments"][number] = {
        title: deployment.name ?? "Unnamed deployment",
        chips: [deployment.model.format, deployment.model.name, deployment.model.version].filter(
          (value): value is string => Boolean(value),
        ),
        badges: full
          ? [
              deployment.deployment?.deploymentState,
              deployment.deployment?.provisioningState,
            ].filter((value): value is string => Boolean(value))
          : [],
        limits: [
          ...(typeof deployment.limits?.maxContextTokens === "number"
            ? [
                {
                  label: "Max context tokens",
                  value: deployment.limits.maxContextTokens,
                  title: "Maximum context/input token window reported by Azure.",
                },
              ]
            : []),
          ...(typeof deployment.limits?.maxOutputTokens === "number"
            ? [
                {
                  label: "Max output tokens",
                  value: deployment.limits.maxOutputTokens,
                  title: "Maximum output/completion token window reported by Azure.",
                },
              ]
            : []),
        ],
        details: full
          ? [
              ...(deployment.deployment?.sku?.name
                ? [{ label: "SKU", valueText: deployment.deployment.sku.name }]
                : []),
              ...(typeof deployment.deployment?.sku?.capacity === "number"
                ? [
                    {
                      label: "SKU capacity",
                      valueText: String(deployment.deployment.sku.capacity),
                    },
                  ]
                : []),
              ...(typeof deployment.deployment?.currentCapacity === "number"
                ? [
                    {
                      label: "Current capacity",
                      valueText: String(deployment.deployment.currentCapacity),
                    },
                  ]
                : []),
              ...(deployment.deployment?.raiPolicyName
                ? [{ label: "RAI policy", valueText: deployment.deployment.raiPolicyName }]
                : []),
              ...(endpointRows.length > 0
                ? [
                    {
                      label: `V1 endpoint${endpointRows.length > 1 ? "s" : ""}`,
                      valueHtml: endpointRows.join("<br>"),
                      wide: true,
                    },
                  ]
                : []),
            ]
          : [],
        rateLimits: buildRateLimitRows(rateLimits),
        capabilities: full
          ? Object.entries(deployment.capabilities ?? {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => ({ key, value: String(value) }))
          : [],
      }

      if (full) {
        const providerConfig = buildProviderConfig(data.resource.accountName, deployment, index)
        if (providerConfig) card.providerConfig = providerConfig
      }

      return card
    }),
  }
}
