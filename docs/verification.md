# Jev Agent Hosts: Verification Report

## 1. Summary of Execution

- **Environment**: Node.js `v24.18.0`, Pi `0.87.1`, Windows 11.
- **Total Tests Executed**: 63 (Integration, Core, Deploy, Manifest, and Unit)
- **Passing**: 63
- **Failing**: 0
- **Regression Status**: 100% PASS

## 2. Test Coverage Matrix

| Test Suite | File | Tests | Status | Key Validations |
| :--- | :--- | :---: | :---: | :--- |
| **Core Retention Engine** | `tests/core.test.ts` | 14 | PASS | First constraint pinned, recent 6 pinned, pair handling (drop/truncate), orphan protection, unreplayable/opaque preserved, fail-open on timeout/malformed, min compression gain, deduplication hash, token/password redaction, raw `Authorization: Bearer\|Basic <credential>` header redaction, reserved Phase 2 adapter check, WindowsJevTransport strict key file authority (empty key file never falls back to env var) |
| **Pi Host Adapter** | `tests/pi-adapter.test.ts` | 12 | PASS | Real Pi `prepareCompaction` + `SessionEntry[]` event structures from `@earendil-works/pi-coding-agent`; split turn handling with `turnPrefixMessages`; genuine token estimation preventing character-token conflation; `CompactionResult` `tokensBefore`, `usage` object, and authentic `estimatedTokensAfter: result.stats.tokensAfter`; token metric consistency (all-kept plan yields zero saved tokens and tokensAfter === tokensBefore); extension fallback: "native" flag and notify status message; `/jev` command with valid JSON, invalid JSON, and error handling without false positives; extension lifecycle and coexistence with `jev-router.ts` |
| **Antigravity Plugin Integration** | `tests/antigravity-plugin.test.ts` | 25 | PASS | Official Antigravity `PostToolUse` contract alignment; exact `GENERIC` DONE entry matching by `step_index === Number(stepIdx)` for tools like `view_file`; strict mismatch rejection; strict `PLANNER_RESPONSE` exclusion; backfill of pending fallback evidence on subsequent PostToolUse and PreInvocation; portable isolated deployment verification; deploy cleanup of `plugins.json` and legacy folders; snippet injection in `PreInvocation`; key file priority and empty key file non-fallback; atomic writes; session isolation; deduplication hash; network fail-open; corrupt file resilience; paths with spaces |
| **Antigravity Plugin Unit** | `packages/antigravity-plugin/tests/plugin.test.mjs` | 4 | PASS | Manifest validation, hooks configuration, sensitive data redaction helper, raw Authorization header redaction |
| **Deploy Idempotency** | `tests/deploy-idempotency.test.ts` | 1 | PASS | Preserves content outside markers and remains idempotent across multiple deploys |
| **Deploy Manifest** | `tests/deploy-manifest.test.ts` | 1 | PASS | Deploys all hosts to expected paths as documented in README.md |
| **Runtime Validation** | `tests/runtime-env.test.ts` | 3 | PASS | Missing JEV_API_URL returns JSON error and non-zero exit code |
| **Live Smoke Tests** | `tests/e2e-smoke.test.ts` | 3 | PASS | Live JevRouter runner payload, live `WindowsJevTransport` query to endpoint, live `JevRetentionEngine` compaction planning on synthetic evidence |

## 3. Verification Claims & Host Status

This section mirrors the verification table in the README.

- **Pi: real runtime compaction (RPC)**: **verified**. Jev was invoked, kept all tool calls, and Pi's native compaction ran.
- **Pi: Jev drop/truncate on a real host**: **not yet observed**, because Jev has not chosen to drop or truncate in a live run. The path is covered by automated tests.
- **Pi: TUI display of `/jev-compact-status`**: **verified**. It was checked by hand in the interactive Pi TUI, and the output displays correctly.
- **Antigravity: evidence recall hooks**: **verified on a real host**. This covers `PostToolUse` recording, `PreInvocation` injection, and credential redaction. Tool output capture, including `view_file`, was verified in a live conversation: 60 evidence records, 0 fallbacks. Antigravity writes a tool's transcript entry only after the hook returns, so each record's output is backfilled on the next hook invocation.
- **Antigravity: router skill**: **loaded**. The skill is listed in the Antigravity Customizations panel. The routing call itself is only verified with synthetic inputs.
- **Codex: compaction hooks**: verified only with a synthetic `PreCompact` / `SessionStart(compact)` round-trip.
- **Claude Code / Codex: routing**: verified with a live route through the shared runtime and synthetic candidates.

## 4. Live Smoke Test Details

### Live Provider Query
- **Endpoint**: Configured Jev System One endpoint
- **Model**: `jev-1.13.0`
- **Live Provider Response Received**: `true`
- **Status**: `selected`
- **Selected Candidate**: `search`
- **Confidence**: `0.99`
- **Execution Status**: `not_started` (`"execution": { "enabled": false, "status": "not_started" }`)
- **Key Security Guarantee**: No key printed to stdout, stderr, or written to logs.

## 5. Extension Discovery in Pi

Verified using Pi's internal extension loader (`discoverAndLoadExtensions`):
- `jev-context-compaction.ts`: discovered, loaded, exposes commands `[ 'jev-compact-status', 'jev' ]`. Standalone ESM bundle with zero workspace dependencies.
- `jev-router.ts`: preserved, loaded, exposes commands `[ 'jev' ]` and tools `[ 'jev_route' ]`.
