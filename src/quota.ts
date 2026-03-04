import type { FetchFunction } from "@ai-sdk/provider-utils"
import type { ApiMode } from "./url"
import { sanitizeBody, shouldRetryWithSanitizedBody } from "./quota-sanitize"
import {
  clampPositive,
  estimateRequestedTokens,
  getRpmWaitMs,
  getTpmWaitMs,
  isRetryableStatus,
  jitterDelay,
  parseHeaderInt,
  parseJsonBody,
  parseRetryAfterMs,
  stringifyBody,
} from "./quota-utils"

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
  tokens: TokenEvent[]
  lastSeen: number
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

function abortError(): Error {
  return new DOMException("The operation was aborted", "AbortError")
}

function waitMs(delay: number, signal?: AbortSignal | null): Promise<void> {
  if (delay <= 0) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delay)

    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(abortError())
    }

    signal?.addEventListener("abort", onAbort, { once: true })
  })
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

  resolveSanitizationPolicy(modelId: string | undefined): AssistantReasoningSanitizationPolicy {
    const perModel = modelId
      ? this.options?.modelOptions?.[modelId]?.assistantReasoningSanitization
      : undefined
    if (perModel) return perModel

    if (modelId && this.sanitizeAlways.has(modelId)) return "always"

    const global = this.options?.assistantReasoningSanitization
    if (global) return global

    return "auto"
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
      tokens: [],
      lastSeen: now,
    }
    this.windows.set(modelId, created)
    return created
  }

  private maybeSweep(now: number): void {
    if (now - this.lastSweepAt < this.runtime.windowMs) return
    this.lastSweepAt = now

    for (const [modelId, window] of this.windows.entries()) {
      this.prune(window, now)
      const idle = window.active === 0 && window.requests.length === 0 && window.tokens.length === 0
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
    while (
      window.requests.length > 0 &&
      window.requests[0] !== undefined &&
      window.requests[0] < min
    ) {
      window.requests.shift()
    }
    while (
      window.tokens.length > 0 &&
      window.tokens[0] !== undefined &&
      window.tokens[0].at < min
    ) {
      window.tokens.shift()
    }
  }

  async acquire(
    modelId: string | undefined,
    estimatedTokens: number,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const resolvedModel = modelId ?? "__default__"
    const rule = this.resolveRule(modelId)
    const hasLimits = hasAnyLimit(rule)
    const now = this.runtime.now()
    this.maybeSweep(now)

    if (!hasLimits) {
      if (this.cooldownUntil > now) {
        await this.runtime.wait(this.cooldownUntil - now, signal)
      }
      return () => {}
    }

    const maxConcurrent = clampPositive(rule.maxConcurrent)
    const rpm = clampPositive(rule.rpm)
    const tpm = clampPositive(rule.tpm)
    const enforceTpm = tpm !== undefined && estimatedTokens <= tpm

    const window = this.getWindow(resolvedModel, now)

    while (true) {
      const now = this.runtime.now()
      window.lastSeen = now

      if (signal?.aborted) {
        throw abortError()
      }

      if (this.cooldownUntil > now) {
        await this.runtime.wait(this.cooldownUntil - now, signal)
        continue
      }

      this.prune(window, now)

      let waitFor = 0

      if (maxConcurrent !== undefined && window.active >= maxConcurrent) {
        waitFor = Math.max(waitFor, 50)
      }

      if (rpm !== undefined) {
        waitFor = Math.max(waitFor, getRpmWaitMs(this.runtime.windowMs, window.requests, now, rpm))
      }

      if (enforceTpm && tpm !== undefined) {
        waitFor = Math.max(
          waitFor,
          getTpmWaitMs(this.runtime.windowMs, window.tokens, now, tpm, estimatedTokens),
        )
      }

      if (waitFor > 0) {
        await this.runtime.wait(waitFor, signal)
        continue
      }

      window.active += 1
      window.requests.push(now)
      if (enforceTpm) {
        window.tokens.push({ at: now, tokens: estimatedTokens })
      }
      break
    }

    return () => {
      const next = Math.max(0, window.active - 1)
      window.active = next
      window.lastSeen = this.runtime.now()
      this.maybeSweep(window.lastSeen)
    }
  }

  setCooldown(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs <= 0) return
    const target = this.runtime.now() + delayMs
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

  applyRateLimitHeaders(response: Response): void {
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
      this.setCooldown(Math.max(adaptive.minCooldownMs, this.runtime.windowMs))
      return
    }

    if (remainingTokens !== undefined && remainingTokens <= 0) {
      this.setCooldown(Math.max(adaptive.minCooldownMs, this.runtime.windowMs))
      return
    }

    if (nearRequestFloor || nearTokenFloor) {
      this.setCooldown(Math.max(adaptive.minCooldownMs, adaptive.lowCooldownMs))
      return
    }
  }

  getRetryOptions(): ResolvedRetry {
    return {
      maxAttempts: Math.max(
        1,
        Math.floor(this.options?.quota?.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts),
      ),
      baseDelayMs: Math.max(
        1,
        Math.floor(this.options?.quota?.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs),
      ),
      maxDelayMs: Math.max(
        1,
        Math.floor(this.options?.quota?.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs),
      ),
      jitterRatio: Math.max(
        0,
        this.options?.quota?.retry?.jitterRatio ?? DEFAULT_RETRY.jitterRatio,
      ),
      honorRetryAfter: this.options?.quota?.retry?.honorRetryAfter ?? DEFAULT_RETRY.honorRetryAfter,
      cooldownOn429Ms: Math.max(
        0,
        Math.floor(this.options?.quota?.retry?.cooldownOn429Ms ?? DEFAULT_RETRY.cooldownOn429Ms),
      ),
    }
  }

  clampMaxOutput(body: Record<string, unknown>): Record<string, unknown> {
    const modelId = typeof body["model"] === "string" ? body["model"] : undefined
    const cap = clampPositive(this.resolveRule(modelId).maxOutputTokensCap)
    if (cap === undefined) return body

    const next = { ...body }

    if (typeof next["max_tokens"] === "number" && next["max_tokens"] > cap) {
      next["max_tokens"] = cap
    }

    if (typeof next["max_completion_tokens"] === "number" && next["max_completion_tokens"] > cap) {
      next["max_completion_tokens"] = cap
    }

    return next
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
    const retry = governor.getRetryOptions()
    let attempt = 0
    let autoFallbackTried = false

    while (attempt < retry.maxAttempts) {
      attempt += 1

      const baseInit = init ? { ...init } : undefined
      let parsed = parseJsonBody(baseInit?.body)
      if (parsed) {
        parsed = governor.clampMaxOutput(parsed)
      }

      const modelId = parsed && typeof parsed["model"] === "string" ? parsed["model"] : undefined
      const sanitization = governor.resolveSanitizationPolicy(modelId)
      const shouldSanitize = sanitization === "always"

      if (parsed && shouldSanitize) {
        parsed = sanitizeBody(parsed)
      }

      const estimatedTokens = parsed ? estimateRequestedTokens(parsed) : 512

      const nextInit = parsed
        ? {
            ...baseInit,
            body: stringifyBody(parsed),
          }
        : baseInit

      const release = await governor.acquire(
        modelId,
        estimatedTokens,
        nextInit?.signal ?? undefined,
      )

      let response: Response
      try {
        response = await fetchFn(input, nextInit)
      } catch (error) {
        release()

        if (attempt >= retry.maxAttempts || isAbortLikeError(error)) {
          throw error
        }

        const base = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
        const delay = jitterDelay(base, retry.jitterRatio)
        await waitMs(delay, nextInit?.signal)
        continue
      }

      release()

      governor.applyRateLimitHeaders(response)

      if (!shouldSanitize && sanitization === "auto" && !autoFallbackTried) {
        const shouldFallback = await shouldRetryWithSanitizedBody(response)
        if (shouldFallback) {
          governor.rememberSanitizeAlways(modelId)
          autoFallbackTried = true
          attempt -= 1
          continue
        }
      }

      if (!isRetryableStatus(response.status) || attempt >= retry.maxAttempts) {
        return response
      }

      if (response.status === 429) {
        const retryAfterMs = retry.honorRetryAfter
          ? parseRetryAfterMs(response.headers.get("retry-after"), governor.nowMs())
          : undefined
        const fallback = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1))
        const cooldown = Math.max(retry.cooldownOn429Ms, retryAfterMs ?? 0)
        governor.setCooldown(cooldown)
        await waitMs(
          Math.max(retryAfterMs ?? 0, jitterDelay(fallback, retry.jitterRatio)),
          nextInit?.signal,
        )
        continue
      }

      const delay = jitterDelay(
        Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1)),
        retry.jitterRatio,
      )
      await waitMs(delay, nextInit?.signal)
    }

    return fetchFn(input, init)
  }

  return Object.assign(wrapped, {
    preconnect: fetchFn.preconnect,
  }) as FetchFunction
}

export const __test = {
  parseRetryAfterMs,
  createGovernor: (options?: RequestPolicyOptions, runtime?: Partial<GovernorRuntime>) =>
    new QuotaGovernor(options, {
      now: runtime?.now ?? (() => Date.now()),
      wait: runtime?.wait ?? waitMs,
      windowMs: runtime?.windowMs ?? WINDOW_MS,
    }),
}
