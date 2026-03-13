/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

export { buildHtmlReportViewModel } from "./view-model"
export type { HtmlReportViewModel } from "./view-model"
export { escapeHtml } from "./html-escape"
export {
  v1BaseUrl,
  hasCapability,
  inferV1Endpoints,
  preferredEndpoint,
  isFullDeployment,
} from "./endpoints"
export {
  providerConfigObject,
  buildProviderConfig,
  type ProviderConfigViewModel,
} from "./provider-config"
export {
  formatCompactCount,
  rateLimitCount,
  buildRateLimitRows,
  type RateLimitRow,
} from "./display"
