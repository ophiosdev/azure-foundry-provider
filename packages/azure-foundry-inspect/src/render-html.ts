/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { readFile } from "node:fs/promises"
import ejs from "ejs"
import type { Output, RateLimitsOutput } from "./types"
import { buildHtmlReportViewModel } from "./render-html/view-model"

let cachedTemplate: string | undefined
let cachedCss: string | undefined
let cachedJs: string | undefined

async function loadText(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8")
}

async function assets(): Promise<{ template: string; css: string; js: string }> {
  cachedTemplate ??= await loadText("./render-html/template.ejs")
  cachedCss ??= await loadText("./render-html/inline.css")
  cachedJs ??= await loadText("./render-html/inline.js")
  return {
    template: cachedTemplate,
    css: cachedCss,
    js: cachedJs,
  }
}

export async function renderHtmlReport(data: Output | RateLimitsOutput): Promise<string> {
  const viewModel = buildHtmlReportViewModel(data)
  const { template, css, js } = await assets()
  return ejs.render(template, {
    page: viewModel.page,
    summaryRows: viewModel.summaryRows,
    deployments: viewModel.deployments,
    inlineCss: css,
    inlineJs: js,
  })
}
