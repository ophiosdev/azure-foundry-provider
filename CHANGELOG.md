# Changelog

All notable changes to this project are documented in this file.

The format is based on Keep a Changelog, adapted for this local repository snapshot.

## [Unreleased]

## [0.2.0] - 2026-03-08

### Added

- Bidirectional operation-mismatch auto-recovery in `provider.languageModel(...)`, allowing one retry from `chat` to `responses` or from `responses` to `chat` when Azure rejects the attempted operation for globally configured or URL-inferred modes.
- Directional operation-mismatch detection that distinguishes rejected `chat` and rejected `responses` requests while preserving bounded response-body parsing.
- Regression coverage for bidirectional fallback, strict per-model mode behavior, strict transport accessors, generic `400` safety, and one-retry fallback limits.
- Detailed implementation handoff notes in `docs/implementation-bidirectional-fallback-handoff.md` and supporting evidence artifacts under `.evidence/phase-11/`.

### Changed

- Fallback policy for `languageModel(...)` now treats global `apiMode` and URL-inferred mode as first-attempt defaults instead of strict no-recovery selections.
- `onFallback` observability payloads and README guidance now describe both fallback directions and clarify that strict per-model `apiMode` disables auto-recovery.
- The legacy fallback scenario matrix in `test/provider.test.ts` was rewritten to the new bidirectional contract and now verifies exact request URL sequences.

### Fixed

- Prevented generic `400 Bad Request` responses, advisory text, content-filter responses, and assistant reasoning validation errors from triggering cross-transport fallback.
- Preserved stable `model.provider` identity on wrapped `languageModel(...)` instances after adding fallback wrappers.
- Closed the gap where a globally misconfigured `apiMode` could surface Azure's operation-mismatch error without automatic recovery.

## [0.1.0] - 2026-03-04

### Added

- Initial release of `azure-foundry-provider` with URL-first routing for Azure Foundry and Azure OpenAI-compatible endpoints.
- Support for chat and responses transports, `/openai/v1` base-root handling with explicit `apiMode`, and per-model mode overrides.
- Quota management with retries, adaptive throttling, max-concurrency admission, cooldown handling, and assistant reasoning sanitization controls.
- Observability callbacks for retries, adaptive cooldown, sanitized retries, and fallback decisions.
- Comprehensive README documentation and test coverage for provider, quota, observability, and endpoint parsing behavior.
