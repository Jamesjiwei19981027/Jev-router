# Jev Agent Hosts: Operations Guide

This guide details the procedures for deployment, status verification, upgrades, uninstallations, and rollbacks for all supported host agents: Claude Code, Codex, Pi, and Antigravity.

---

## 1. Environment & Prerequisites

- **Operating System**: Windows (tested on Windows 11), Node.js ≥ 22.6
- **Git**: Required for fetching and locking upstream projects
- **Jev Endpoint**: Jev System One-compatible API endpoint configured via `JEV_API_URL`
- **Jev Model**: `jev-1.13.0` (default) or custom model via `JEV_MODEL`
- **Secret File**: `~/.jev-agent/secrets/typesafe_api_key` (recommended) or `TYPESAFE_API_KEY`
- **Supported Hosts**: Any or all of Claude Code, Codex, Pi, and Antigravity

---

## 2. Installation & Setup

1. **Install Shared Runtime & Locked Upstream Tools**:
   ```powershell
   npm run setup
   ```
   This installs runtime binaries into `~/.jev-agent/bin/` and sets up pinned commits of upstream JevRouter and save-token-jev in `~/.jev-agent/vendor/`.

2. **Deploy Integration**:
   ```powershell
   # Deploy to all hosts
   npm run deploy -- --host all

   # Or deploy to specific hosts
   npm run deploy -- --host claude-code
   npm run deploy -- --host codex
   npm run deploy -- --host pi
   npm run deploy -- --host antigravity
   ```

   Deployment is safe and idempotent:
   - All replaced or updated files are automatically backed up to `~/.jev-agent/backups/<timestamp>/`.
   - Routing rules in `CLAUDE.md` and `AGENTS.md` are inserted/updated strictly within the `<!-- jev-agent:global-routing-v1 -->` markers.

---

## 3. Verification & Doctor

1. **Check Service Connectivity**:
   ```powershell
   npm run doctor
   ```
   Verifies the endpoint and served models without printing credentials.

2. **Run Automated Test Suite**:
   ```powershell
   npm test
   ```

3. **Pi Interactive Check**:
   - Run `pi` in interactive mode.
   - Run `/jev-compact-status` to inspect compaction state.
   - Run `/jev` for a routing smoke test.

4. **Codex Hooks Verification**:
   - Check `~/.codex/hooks.json` points to the installed hook runner.
   - In Codex, inspect `/hooks` to ensure hooks are loaded and trusted.

---

## 4. Rollback & Uninstall

Every deployment creates a timestamped snapshot under `~/.jev-agent/backups/<timestamp>/`.

1. **Rollback Files**:
   Copy the backed-up files from the desired backup folder back to their respective host locations.

2. **Remove Routing Rules**:
   Remove the block between `<!-- jev-agent:global-routing-v1 -->` and `<!-- /jev-agent:global-routing-v1 -->` in `CLAUDE.md` or `AGENTS.md`.

3. **Remove Extensions / Plugins**:
   - Pi: Delete `~/.pi/agent/extensions/jev-context-compaction.ts` and `~/.pi/agent/extensions/jev-router.ts`.
   - Antigravity: Remove `~/.gemini/config/plugins/jev-context-compaction` and `~/.gemini/config/plugins/jev-router`.
   - Claude: Remove `~/.claude/skills/jevrouter/`.
   - Codex: Remove `~/.codex/skills/jevrouter/` and reset `~/.codex/hooks.json`.
