/*
 * SPDX-FileCopyrightText: 2026 Ophios GmbH and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { FetchFunction } from "@ai-sdk/provider-utils"
import type { ApiMode } from "./url"
import { sanitizeBody, shouldRetryWithSanitizedBody } from "./quota-sanitize"
import {
  clampPositive,
  estimateRequestedTokens,
  getRpmWaitMs,
  isRetryableStatus,
  jitterDelay,
  parseHeaderInt,
  parseJsonBody,
  parseRetryAfterMs,
  stringifyBody,
} from "./quota-utils"
import { AuthenticationFailure, requestSignal, wrapResponseBody } from "./provider-runtime"

export type QuotaRule = {
  rpm?: number
  tpm?: number
  maxConcurrent?: number
  maxOutputTokensCap?: number
}

export type QuotaRetryOptions = {
  maxAttempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
  honorRetryAfter?: boolean
  cooldownOn429Ms?: number
}

export type QuotaOptions = {
  default?: QuotaRule
  models?: Record<string, QuotaRule>
  retry?: QuotaRetryOptions
  adaptive?: QuotaAdaptiveOptions
}

export type AssistantReasoningSanitizationPolicy = "auto" | "always" | "never"

export type ModelRequestOptions = {
  apiMode?: ApiMode
  assistantReasoningSanitization?: AssistantReasoningSanitizationPolicy
}

export type RequestPolicyOptions = {
  quota?: QuotaOptions
  assistantReasoningSanitization?: AssistantReasoningSanitizationPolicy
  modelOptions?: Record<string, ModelRequestOptions>
  cooldownScope?: "global" | "per-model"
  onRetry?: (event: RetryEvent) => void
  onAdaptiveCooldown?: (event: AdaptiveCooldownEvent) => void
  onSanitizedRetry?: (event: SanitizedRetryEvent) => void
}

export type RetryEvent = {
  eventVersion: "v1"
  phase: "retry"
  attempt: number
  reason: string
  status?: number
  retryAfterMs?: number
  modelId?: string
}

export type AdaptiveCooldownEvent = {
  eventVersion: "v1"
  phase: "adaptive_cooldown"
  cooldownMs: number
  reason: string
  remainingRequests?: number
  remainingTokens?: number
  modelId?: string
}

export type SanitizedRetryEvent = {
  eventVersion: "v1"
  phase: "sanitized_retry"
  reason: string
  sanitizedFields: string[]
  status?: number
  modelId?: string
}

export type QuotaAdaptiveOptions = {
  enabled?: boolean
  minCooldownMs?: number
  lowWatermarkRatio?: number
  lowCooldownMs?: number
}

type TokenEvent = {
  at: number
  tokens: number
}

type WindowState = {
  active: number
  requests: number[]
  requestHead: number
  tokens: TokenEvent[]
  tokenHead: number
  tokenSum: number
  lastSeen: number
  waiters: Array<() => void>
}

type ResolvedRetry = {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
  jitterRatio: number
  honorRetryAfter: boolean
  cooldownOn429Ms: number
}

type ResolvedAdaptive = {
  enabled: boolean
  minCooldownMs: number
  lowWatermarkRatio: number
  lowCooldownMs: number
}

type GovernorRuntime = {
  now: () => number
  wait: (delay: number, signal?: AbortSignal | null) => Promise<void>
  windowMs: number
}

const WINDOW_MS = 60_000

const DEFAULT_RETRY: ResolvedRetry = {
  maxAttempts: 4,
  baseDelayMs: 1200,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
  honorRetryAfter: true,
  cooldownOn429Ms: 10_000,
}

const DEFAULT_ADAPTIVE: ResolvedAdaptive = {
  enabled: true,
  minCooldownMs: 1000,
  lowWatermarkRatio: 0.1,
  lowCooldownMs: 250,
}

const MAX_RETRY_ATTEMPTS = 10
const MAX_RETRY_DELAY_MS = 300_000
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1
const MAX_TIMER_DELAY_BIGINT = BigInt(MAX_TIMER_DELAY_MS)

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function boundedRatio(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.min(1, value))
}

function waitMs(delay: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    // Preserve arbitrary caller-supplied AbortSignal reasons.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(signal.reason)
  }
  if (delay <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const longDelay = delay > MAX_TIMER_DELAY_MS
    let remaining = longDelay ? BigInt(Math.ceil(delay)) : 0n
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort)
    }

    const scheduleNext = () => {
      const chunk = longDelay
        ? Number(remaining > MAX_TIMER_DELAY_BIGINT ? MAX_TIMER_DELAY_BIGINT : remaining)
        : delay
      timer = setTimeout(() => {
        if (longDelay) {
          remaining -= BigInt(chunk)
          if (remaining > 0n) {
            scheduleNext()
            return
          }
        }
        cleanup()
        resolve()
      }, chunk)
    }

    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      cleanup()
      // Preserve arbitrary caller-supplied AbortSignal reasons.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal?.reason)
    }

    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }
    scheduleNext()
  })
}

function visibleLength(items: { length: number }, head: number): number {
  return Math.max(0, items.length - head)
}

function maybeCompact<T>(items: T[], head: number): { items: T[]; head: number } {
  if (head <= 1024 || head * 2 < items.length) {
    return { items, head }
  }
  return { items: items.slice(head), head: 0 }
}

function mergeRule(base: QuotaRule | undefined, override: QuotaRule | undefined): QuotaRule {
  const rpm = override?.rpm ?? base?.rpm
  const tpm = override?.tpm ?? base?.tpm
  const maxConcurrent = override?.maxConcurrent ?? base?.maxConcurrent
  const maxOutputTokensCap = override?.maxOutputTokensCap ?? base?.maxOutputTokensCap

  return {
    ...(rpm !== undefined ? { rpm } : {}),
    ...(tpm !== undefined ? { tpm } : {}),
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(maxOutputTokensCap !== undefined ? { maxOutputTokensCap } : {}),
  }
}

function hasAnyLimit(rule: QuotaRule): boolean {
  return (
    clampPositive(rule.rpm) !== undefined ||
    clampPositive(rule.tpm) !== undefined ||
    clampPositive(rule.maxConcurrent) !== undefined ||
    clampPositive(rule.maxOutputTokensCap) !== undefined
  )
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === "AbortError"
}

class QuotaGovernor {
  private readonly options: RequestPolicyOptions | undefined
  private readonly runtime: GovernorRuntime
  private readonly windows = new Map<string, WindowState>()
  private readonly sanitizeAlways = new Set<string>()
  private cooldownUntil = 0
  private cooldownByModel = new Map<string, number>()
  private lastSweepAt = 0

  constructor(options: RequestPolicyOptions | undefined, runtime: GovernorRuntime) {
    this.options = options
    this.runtime = runtime
  }

  private resolveRule(modelId: string | undefined): QuotaRule {
    if (!this.options?.quota) return {}
    const base = this.options.quota.default
    const specific = modelId ? this.options.quota.models?.[modelId] : undefined
    return mergeRule(base, specific)
  }

  hasConcurrentLimit(modelId: string | undefined): boolean {
    return clampPositive(this.resolveRule(modelId).maxConcurrent) !== undefined
  }

  hasTokenLimit(modelId: string | undefined): boolean {
    return clampPositive(this.resolveRule(modelId).tpm) !== undefined
  }

  resolveSanitizationPolicy(modelId: string | undefined): AssistantReasoningSanitizationPolicy {
    const perModel = modelId
      ? this.options?.modelOptions?.[modelId]?.assistantReasoningSanitization
      : undefined
    const configured = perModel ?? this.options?.assistantReasoningSanitization ?? ("auto" as const)
    if (configured === "auto" && modelId && this.sanitizeAlways.has(modelId)) return "always"
    return configured
  }

  rememberSanitizeAlways(modelId: string | undefined): void {
    if (!modelId) return
    this.sanitizeAlways.add(modelId)
  }

  private getWindow(modelId: string, now: number): WindowState {
    const existing = this.windows.get(modelId)
    if (existing) {
      existing.lastSeen = now
      return existing
    }

    const created: WindowState = {
      active: 0,
      requests: [],
      requestHead: 0,
      tokens: [],
      tokenHead: 0,
      tokenSum: 0,
      lastSeen: now,
      waiters: [],
    }
    this.windows.set(modelId, created)
    return created
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.runtime.windowMs) return
    this.lastSweepAt = now

    for (const [modelId, window] of this.windows.entries()) {
      this.prune(window, now)
      const idle =
        window.active === 0 &&
        visibleLength(window.requests, window.requestHead) === 0 &&
        visibleLength(window.tokens, window.tokenHead) === 0
      if (!idle) continue
      if (now - window.lastSeen <= this.runtime.windowMs) continue
      this.windows.delete(modelId)
    }
  }

  windowCount(): number {
    return this.windows.size
  }

  private prune(window: WindowState, now: number): void {
    const min = now - this.runtime.windowMs
    while (window.requestHead < window.requests.length) {
      const value = window.requests[window.requestHead]
      if (value === undefined || value >= min) break
      window.requestHead += 1
    }
    while (window.tokenHead < window.tokens.length) {
      const value = window.tokens[window.tokenHead]
      if (value === undefined || value.at >= min) break
      window.tokenSum -= value.tokens
      window.tokenHead += 1
    }

    const compactRequests = maybeCompact(window.requests, window.requestHead)
    window.requests = compactRequests.items
    window.requestHead = compactRequests.head

    const compactTokens = maybeCompact(window.tokens, window.tokenHead)
    window.tokens = compactTokens.items
    window.tokenHead = compactTokens.head
  }

  private activeRequests(window: WindowState): number[] {
    return window.requestHead === 0 ? window.requests : window.requests.slice(window.requestHead)
  }

  private tokenWaitMs(window: WindowState, now: number, limit: number, pending: number): number {
    if (pending > limit) return 0
    if (window.tokenSum + pending <= limit) return 0
    let sum = window.tokenSum
    for (let i = window.tokenHead; i < window.tokens.length; i += 1) {
      const event = window.tokens[i]
      if (event === undefined) continue
      sum -= event.tokens
      if (sum + pending <= limit) {
        return Math.max(1, event.at + this.runtime.windowMs - now)
      }
    }
    return this.runtime.windowMs
  }

  debugWindowState(
    modelId: string,
  ):
    { requestsLength: number; tokensLength: number; tokenSum: number; active: number } | undefined {
    const window = this.windows.get(modelId)
    if (!window) return undefined
    return {
      requestsLength: visibleLength(window.requests, window.requestHead),
      tokensLength: visibleLength(window.tokens, window.tokenHead),
      tokenSum: window.tokenSum,
      active: window.active,
    }
  }

  async acquire(
    modelId: string | undefined,
    estimatedTokens: number,
    signal?: AbortSignal,
  ): Promise<() => void> {
    if (signal?.aborted) throw signal.reason

    const resolvedModel = modelId ?? "__default__"
    const rule = this.resolveRule(modelId)
    const hasLimits = hasAnyLimit(rule)
    const now = this.runtime.now()
    this.maybeSweep(now)
    const cooldownScope = this.options?.cooldownScope ?? "global"

    if (!hasLimits) {
      const modelCooldown =
        cooldownScope === "per-model" && modelId
          ? (this.cooldownByModel.get(modelId) ?? 0)
          : this.cooldownUntil
      if (modelCooldown > now) {
        await this.runtime.wait(modelCooldown - now, signal)
      }
      if (signal?.aborted) throw signal.reason
      return () => {}
    }

    const maxConcurrent = clampPositive(rule.maxConcurrent)
    const rpm = clampPositive(rule.rpm)
    const tpm = clampPositive(rule.tpm)
    const enforceTpm = tpm !== undefined && estimatedTokens <= tpm

    const window = this.getWindow(resolvedModel, now)
    let wokeFromConcurrentWait = false

    while (true) {
      const now = this.runtime.now()
      window.lastSeen = now

      if (signal?.aborted) {
        if (wokeFromConcurrentWait) {
          window.waiters.shift()?.()
        }
        throw signal.reason
      }

      const modelCooldown =
        cooldownScope === "per-model" && modelId
          ? (this.cooldownByModel.get(modelId) ?? 0)
          : this.cooldownUntil
      if (modelCooldown > now) {
        await this.runtime.wait(modelCooldown - now, signal)
        continue
      }

      this.prune(window, now)

      let waitFor = 0

      if (maxConcurrent !== undefined && window.active >= maxConcurrent) {
        await new Promise<void>((resolve, reject) => {
          const onWake = () => {
            wokeFromConcurrentWait = true
            signal?.removeEventListener("abort", onAbort)
            resolve()
          }
          const onAbort = () => {
            const idx = window.waiters.indexOf(onWake)
            if (idx >= 0) window.waiters.splice(idx, 1)
            signal?.removeEventListener("abort", onAbort)
            // Preserve arbitrary caller-supplied AbortSignal reasons.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(signal?.reason)
          }

          window.waiters.push(onWake)
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener("abort", onAbort, { once: true })
        })
        continue
      }
      wokeFromConcurrentWait = false

      if (rpm !== undefined) {
        waitFor = Math.max(
          waitFor,
          getRpmWaitMs(this.runtime.windowMs, this.activeRequests(window), now, rpm),
        )
      }

      if (enforceTpm && tpm !== undefined) {
        waitFor = Math.max(waitFor, this.tokenWaitMs(window, now, tpm, estimatedTokens))
      }

      if (waitFor > 0) {
        await this.runtime.wait(waitFor, signal)
        continue
      }

      window.active += 1
      window.requests.push(now)
      if (enforceTpm) {
        window.tokens.push({ at: now, tokens: estimatedTokens })
        window.tokenSum += estimatedTokens
      }
      break
    }

    return () => {
      const next = Math.max(0, window.active - 1)
      window.active = next
      window.lastSeen = this.runtime.now()
      const waiter = window.waiters.shift()
      waiter?.()
      this.maybeSweep(window.lastSeen)
    }
  }

  setCooldown(delayMs: number, modelId?: string): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return
    const target = this.runtime.now() + delayMs
    const scope = this.options?.cooldownScope ?? "global"
    if (scope === "per-model" && modelId) {
      this.cooldownByModel.set(modelId, Math.max(this.cooldownByModel.get(modelId) ?? 0, target))
      return
    }
    this.cooldownUntil = Math.max(this.cooldownUntil, target)
  }

  nowMs(): number {
    return this.runtime.now()
  }

  getAdaptiveOptions(): ResolvedAdaptive {
    return {
      enabled: this.options?.quota?.adaptive?.enabled ?? DEFAULT_ADAPTIVE.enabled,
      minCooldownMs: Math.max(
        0,
        Math.floor(this.options?.quota?.adaptive?.minCooldownMs ?? DEFAULT_ADAPTIVE.minCooldownMs),
      ),
      lowWatermarkRatio: Math.max(
        0,
        Math.min(
          1,
          this.options?.quota?.adaptive?.lowWatermarkRatio ?? DEFAULT_ADAPTIVE.lowWatermarkRatio,
        ),
      ),
      lowCooldownMs: Math.max(
        0,
        Math.floor(this.options?.quota?.adaptive?.lowCooldownMs ?? DEFAULT_ADAPTIVE.lowCooldownMs),
      ),
    }
  }

  private emitAdaptiveCooldown(
    cooldownMs: number,
    modelId: string | undefined,
    reason: string,
    remainingRequests?: number,
    remainingTokens?: number,
  ): void {
    this.setCooldown(cooldownMs, modelId)
    this.options?.onAdaptiveCooldown?.({
      eventVersion: "v1",
      phase: "adaptive_cooldown",
      cooldownMs,
      reason,
      ...(remainingRequests !== undefined ? { remainingRequests } : {}),
      ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    })
  }

  applyRateLimitHeaders(response: Response, modelId?: string): void {
    const adaptive = this.getAdaptiveOptions()
    if (!adaptive.enabled) return

    const limitRequests = parseHeaderInt(response.headers, "x-ratelimit-limit-requests")
    const remainingRequests = parseHeaderInt(response.headers, "x-ratelimit-remaining-requests")
    const limitTokens = parseHeaderInt(response.headers, "x-ratelimit-limit-tokens")
    const remainingTokens = parseHeaderInt(response.headers, "x-ratelimit-remaining-tokens")

    const nearRequestFloor =
      limitRequests !== undefined &&
      remainingRequests !== undefined &&
      remainingRequests <= Math.max(1, Math.floor(limitRequests * adaptive.lowWatermarkRatio))

    const nearTokenFloor =
      limitTokens !== undefined &&
      remainingTokens !== undefined &&
      remainingTokens <= Math.max(1, Math.floor(limitTokens * adaptive.lowWatermarkRatio))

    if (remainingRequests !== undefined && remainingRequests <= 0) {
      const cooldownMs = Math.max(adaptive.minCooldownMs, this.runtime.windowMs)
      this.emitAdaptiveCooldown(
        cooldownMs,
        modelId,
        "requests_depleted",
        remainingRequests,
        remainingTokens,
      )
      return
    }

    if (remainingTokens !== undefined && remainingTokens <= 0) {
      const cooldownMs = Math.max(adaptive.minCooldownMs, this.runtime.windowMs)
      this.emitAdaptiveCooldown(
        cooldownMs,
        modelId,
        "tokens_depleted",
        remainingRequests,
        remainingTokens,
      )
      return
    }

    if (nearRequestFloor || nearTokenFloor) {
      const cooldownMs = Math.max(adaptive.minCooldownMs, adaptive.lowCooldownMs)
      this.emitAdaptiveCooldown(
        cooldownMs,
        modelId,
        "low_watermark",
        remainingRequests,
        remainingTokens,
      )
      return
    }
  }

  getRetryOptions(): ResolvedRetry {
    return {
      maxAttempts: boundedInteger(
        this.options?.quota?.retry?.maxAttempts,
        DEFAULT_RETRY.maxAttempts,
        1,
        MAX_RETRY_ATTEMPTS,
      ),
      baseDelayMs: boundedInteger(
        this.options?.quota?.retry?.baseDelayMs,
        DEFAULT_RETRY.baseDelayMs,
        1,
        MAX_RETRY_DELAY_MS,
      ),
      maxDelayMs: boundedInteger(
        this.options?.quota?.retry?.maxDelayMs,
        DEFAULT_RETRY.maxDelayMs,
        1,
        MAX_RETRY_DELAY_MS,
      ),
      jitterRatio: boundedRatio(this.options?.quota?.retry?.jitterRatio, DEFAULT_RETRY.jitterRatio),
      honorRetryAfter: this.options?.quota?.retry?.honorRetryAfter ?? DEFAULT_RETRY.honorRetryAfter,
      cooldownOn429Ms: boundedInteger(
        this.options?.quota?.retry?.cooldownOn429Ms,
        DEFAULT_RETRY.cooldownOn429Ms,
        0,
        MAX_RETRY_DELAY_MS,
      ),
    }
  }

  clampMaxOutput(body: Record<string, unknown>): Record<string, unknown> {
    const modelId = typeof body["model"] === "string" ? body["model"] : undefined
    const cap = clampPositive(this.resolveRule(modelId).maxOutputTokensCap)
    if (cap === undefined) return body

    let next: Record<string, unknown> | undefined
    for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const) {
      const value = body[key]
      if (typeof value === "number" && value > cap) {
        next ??= { ...body }
        next[key] = cap
      }
    }

    return next ?? body
  }
}

export function wrapFetchWithQuota(
  fetchFn: FetchFunction,
  options: RequestPolicyOptions | undefined,
): FetchFunction {
  const governor = new QuotaGovernor(options, {
    now: () => Date.now(),
    wait: waitMs,
    windowMs: WINDOW_MS,
  })

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const callerSignal = requestSignal(input, init)
    if (callerSignal?.aborted) throw callerSignal.reason

    const retry = governor.getRetryOptions()
    let attempt = 0
    let autoFallbackTried = false
    const baseInit = init ? { ...init } : undefined
    const originalBody = baseInit?.body
    const parsedOriginal = parseJsonBody(originalBody)
    const modelIdFromOriginal =
      parsedOriginal && typeof parsedOriginal["model"] === "string"
        ? parsedOriginal["model"]
        : undefined

    let transformedRequest:
      | {
          body: string
          parsed: Record<string, unknown>
          modelId: string | undefined
          estimatedTokens?: number
        }
      | undefined

    const invalidateTransformedCache = (): void => {
      transformedRequest = undefined
    }

    const getTransformed = (): {
      body: BodyInit | null | undefined
      parsed: Record<string, unknown> | undefined
      modelId: string | undefined
      estimatedTokens: number
    } => {
      if (parsedOriginal === undefined) {
        return {
          body: originalBody,
          parsed: undefined,
          modelId: undefined,
          estimatedTokens: governor.hasTokenLimit(undefined) ? 512 : 0,
        }
      }

      if (!transformedRequest) {
        const shouldSanitize = governor.resolveSanitizationPolicy(modelIdFromOriginal) === "always"
        let nextParsed = governor.clampMaxOutput(parsedOriginal)
        if (shouldSanitize) {
          nextParsed = sanitizeBody(nextParsed)
        }
        transformedRequest = {
          body:
            nextParsed === parsedOriginal && typeof originalBody === "string"
              ? originalBody
              : stringifyBody(nextParsed),
          parsed: nextParsed,
          modelId: modelIdFromOriginal,
        }
      }

      const estimatedTokens = governor.hasTokenLimit(transformedRequest.modelId)
        ? (transformedRequest.estimatedTokens ??= estimateRequestedTokens(
            transformedRequest.parsed,
          ))
        : 0

      return {
        body: transformedRequest.body,
        parsed: transformedRequest.parsed,
        modelId: transformedRequest.modelId,
        estimatedTokens,
      }
    }

    while (attempt < retry.maxAttempts) {
      attempt += 1

      const transformed = getTransformed()
      const modelId = transformed.modelId
      const holdConcurrency = governor.hasConcurrentLimit(modelId)
      const sanitization = governor.resolveSanitizationPolicy(modelId)
      const shouldSanitize = sanitization === "always"
      let nextInit = baseInit ? { ...baseInit } : undefined
      if (transformed.body !== undefined) {
        nextInit = {
          ...(nextInit ?? {}),
          body: transformed.body,
        }
      }

      const release = await governor.acquire(modelId, transformed.estimatedTokens, callerSignal)

      let released = false
      const releaseOnce = () => {
        if (released) return
        released = true
        release()
      }

      let response: Response
      try {
        response = await fetchFn(input, nextInit)
      } catch (error) {
        releaseOnce()

        if (callerSignal?.aborted) throw callerSignal.reason
        if (error instanceof AuthenticationFailure) throw error.original
        if (attempt >= retry.maxAttempts || isAbortLikeError(error)) {
          throw error
        }

        const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
        const delay = Math.min(retry.maxDelayMs, jitterDelay(base, retry.jitterRatio))
        await waitMs(delay, callerSignal)
        continue
      }

      const retryableStatus = isRetryableStatus(response.status)
      const probeSanitization =
        !shouldSanitize && sanitization === "auto" && !autoFallbackTried && response.status === 400
      const retryStatus = retryableStatus && attempt < retry.maxAttempts
      if (holdConcurrency || probeSanitization || retryStatus) {
        try {
          response = wrapResponseBody(
            response,
            holdConcurrency && !probeSanitization ? releaseOnce : () => {},
          )
        } catch (error) {
          releaseOnce()
          void response.body?.cancel().catch(() => {})
          throw error
        }
      }
      if (!holdConcurrency) releaseOnce()

      try {
        governor.applyRateLimitHeaders(response, modelId)
      } catch (error) {
        await discardResponse(response)
        releaseOnce()
        throw error
      }

      if (!shouldSanitize && sanitization === "auto" && !autoFallbackTried) {
        const shouldFallback = await shouldRetryWithSanitizedBody(response, callerSignal)
        if (callerSignal?.aborted) {
          await discardResponse(response)
          releaseOnce()
          throw callerSignal.reason
        }
        if (shouldFallback) {
          await discardResponse(response)
          releaseOnce()
          governor.rememberSanitizeAlways(modelId)
          invalidateTransformedCache()
          options?.onSanitizedRetry?.({
            eventVersion: "v1",
            phase: "sanitized_retry",
            reason: "schema_rejection",
            sanitizedFields: ["reasoning_content", "reasoning"],
            status: response.status,
            ...(modelId ? { modelId } : {}),
          })
          autoFallbackTried = true
          attempt -= 1
          continue
        }
        if (holdConcurrency && probeSanitization) {
          try {
            response = wrapResponseBody(response, releaseOnce)
          } catch (error) {
            releaseOnce()
            void response.body?.cancel().catch(() => {})
            throw error
          }
        }
      }

      if (!retryableStatus || attempt >= retry.maxAttempts) {
        return response
      }

      if (response.status === 429) {
        const retryAfterMs = retry.honorRetryAfter
          ? parseRetryAfterMs(response.headers.get("retry-after"), governor.nowMs())
          : undefined
        const fallback = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
        const cooldown = Math.max(retry.cooldownOn429Ms, retryAfterMs ?? 0)
        governor.setCooldown(cooldown, modelId)
        await discardResponse(response)
        options?.onRetry?.({
          eventVersion: "v1",
          phase: "retry",
          attempt,
          reason: "status_429",
          status: 429,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...(modelId ? { modelId } : {}),
        })
        await waitMs(
          Math.max(
            retryAfterMs ?? 0,
            Math.min(retry.maxDelayMs, jitterDelay(fallback, retry.jitterRatio)),
          ),
          callerSignal,
        )
        continue
      }

      const delay = jitterDelay(
        Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1)),
        retry.jitterRatio,
      )
      await discardResponse(response)
      options?.onRetry?.({
        eventVersion: "v1",
        phase: "retry",
        attempt,
        reason: "retryable_status",
        status: response.status,
        ...(modelId ? { modelId } : {}),
      })
      await waitMs(Math.min(retry.maxDelayMs, delay), callerSignal)
    }

    throw new Error("Retry loop exited unexpectedly")
  }

  return Object.assign(wrapped, {
    preconnect: fetchFn.preconnect,
  })
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Discarded response bodies must not block retries.
  }
}

export const __test = {
  parseRetryAfterMs,
  createGovernor: (options?: RequestPolicyOptions, runtime?: Partial<GovernorRuntime>) =>
    new QuotaGovernor(options, {
      now: runtime?.now ?? (() => Date.now()),
      wait: runtime?.wait ?? waitMs,
      windowMs: runtime?.windowMs ?? WINDOW_MS,
    }),
  debugWindowState: (governor: QuotaGovernor, modelId: string) =>
    governor.debugWindowState(modelId),
}
