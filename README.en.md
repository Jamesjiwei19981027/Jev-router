# Jev Agent Hosts

[中文](README.md) | **English**

Give your coding agents a Jev decision layer: **Jev-guided context compaction** and **decision-only capability routing** for **Claude Code, Codex, Pi, and Antigravity**, built on a single shared local runtime.

[Jev](https://github.com/BillionsBobby/JevRouter#readme) is a typed decision model: you ask it one structured question (for example, "which of these tool results still matter?" or "which of these capabilities fits the next step?"), and it returns a typed answer with a confidence value. This repository wires that decision into each agent's native lifecycle. The agent keeps its native behavior as the fallback whenever Jev is unavailable.

> **Status:** early and Windows-first. Everything below was tested on Windows 11 with Node.js 24. macOS and Linux have not been tested yet. See [Verification status](#verification-status) for exactly what has been exercised against real hosts.

---

## Compatibility matrix

| Agent | Context compaction | Capability routing | Integration surface |
| :--- | :--- | :--- | :--- |
| **Claude Code** | — (see [upstream](#upstream-projects)) | ✅ `jevrouter` skill + global routing rule | `~/.claude/skills/jevrouter/`, `~/.claude/CLAUDE.md` |
| **Codex** (CLI / app) | ✅ via save-token-jev hooks (`PreCompact` + `SessionStart(compact)`) | ✅ `jevrouter` skill + global routing rule | `~/.codex/hooks.json`, `~/.codex/skills/jevrouter/`, `~/.codex/AGENTS.md` |
| **Pi** (`@earendil-works/pi-coding-agent`) | ✅ `session_before_compact` extension | ✅ `jev_route` tool + `/jev` command | `~/.pi/agent/extensions/` |
| **Antigravity** | ✅ evidence recall (`PostToolUse` + `PreInvocation` hooks) | ✅ `jev-router` skill plugin | `~/.gemini/config/plugins/` |

What each column means:

- **Context compaction.** When the host compacts its context, Jev decides, for each tool call, whether to keep the full result, keep a truncated result, or drop the call together with its result. User and assistant text are never rewritten.
- **Capability routing.** At a meaningful choice between tools, models, or subagents, the agent asks Jev to pick one. The routing is **decision-only**: it never executes the selected capability. The host's normal permission and confirmation checks still apply.
- **Antigravity** does not expose a compaction replacement hook. Its integration records tool evidence and re-injects a compact recall of that evidence before each model invocation. It does **not** replace Antigravity's native compaction.

---

## How it works

```
                    ┌──────────────────────────── Jev System One endpoint
                    │                               (POST /v1/systemone)
                    ▼
        ┌───────────────────────┐
        │  Shared runtime       │  ~/.jev-agent/bin
        │  jev-agent (doctor /  │  · reads the key from a protected file
        │  route / ask)         │  · timeouts, redacted errors, JSON-only stdout
        │  launchers for        │  · never executes a selected capability
        │  JevRouter and        │
        │  save-token-jev       │
        └──────────┬────────────┘
     ┌─────────────┼──────────────┬─────────────────┐
     ▼             ▼              ▼                 ▼
 Claude Code     Codex            Pi            Antigravity
 skill + rule    skill + rule     extensions    plugins
                 compaction       (compaction   (evidence recall
                 hooks            + router)     + router skill)
```

The Pi and Antigravity compaction adapters share a host-agnostic retention engine (`packages/core`):

```
host context ──capture──▶ ToolEvidence[] ──Jev──▶ RetentionPlan ──apply──▶ host result
```

**Safety invariants enforced by the engine:**

- A tool call and its result are always kept, truncated, or dropped **together**.
- The first message, the most recent messages, and orphan tool results are pinned and never dropped.
- Any Jev failure (timeout, bad response, missing key) **fails open** to the host's native behavior.
- Credentials and `Authorization` headers are redacted from everything the adapters store or log.

---

## Requirements

- Node.js **≥ 22.6** (the test suite uses `--experimental-strip-types`)
- Git (used to fetch the pinned upstream projects)
- A Jev System One–compatible endpoint and an API key for it
- Any of the supported agents installed

---

## Quick start

```powershell
git clone https://github.com/Jamesjiwei19981027/Jev-router.git
cd Jev-router
npm install
npm test
```

### 1. Configure the endpoint and key

There is **no built-in default endpoint**. Set your own:

```powershell
# Windows (user-level environment variables)
setx JEV_API_URL "https://<your-jev-endpoint>/v1/systemone"
setx JEV_MODEL   "jev-1.13.0"
```

```bash
# macOS / Linux (untested)
export JEV_API_URL="https://<your-jev-endpoint>/v1/systemone"
export JEV_MODEL="jev-1.13.0"
```

Store the API key in a file readable only by your user account. Never put it in a prompt, a command argument, or this repository:

```
~/.jev-agent/secrets/typesafe_api_key
```

### 2. Install the shared runtime and upstream tools

```powershell
npm run setup
```

This installs the shared runtime into `~/.jev-agent/bin`, then clones and builds the pinned upstream projects (JevRouter and save-token-jev) into `~/.jev-agent/vendor/`. Upstream code is fetched at install time; it is not vendored in this repository.

### 3. Deploy to the agents you use

```powershell
npm run deploy -- --host claude-code   # jevrouter skill + CLAUDE.md routing rule
npm run deploy -- --host codex         # jevrouter skill + AGENTS.md rule + compaction hooks
npm run deploy -- --host pi            # compaction extension + router extension
npm run deploy -- --host antigravity   # evidence recall plugin + router skill plugin
npm run deploy -- --host all
```

Deployment is idempotent. Every file it changes is backed up first to `~/.jev-agent/backups/<timestamp>/`. The global rules in `CLAUDE.md` and `AGENTS.md` are inserted between `<!-- jev-agent:global-routing-v1 -->` markers, so re-running deploy never duplicates them.

### 4. Check the setup

```powershell
npm run doctor
```

`doctor` checks that the endpoint is reachable and which models it serves, without printing any credential.

After deploying, fully restart Claude Code, Codex, and Pi. In Codex, open `/hooks` and trust the two save-token-jev entries. Antigravity picks up plugins in `~/.gemini/config/plugins/` without a restart.

---

## Configuration reference

| Variable | Required | Default | Purpose |
| :--- | :---: | :--- | :--- |
| `JEV_API_URL` | ✅ | — | Full Jev endpoint, e.g. `https://…/v1/systemone`. The `/v1` base is also accepted. |
| `JEV_MODEL` | | `jev-1.13.0` | Jev model ID. |
| `TYPESAFE_API_KEY_FILE` | | `~/.jev-agent/secrets/typesafe_api_key` | Path to the key file. If the file exists, it is authoritative: an empty file never falls back to an environment variable. |
| `TYPESAFE_API_KEY` | | — | Used only when no key file exists. |
| `JEV_TIMEOUT_MS` | | runtime default | Per-request timeout. |
| `JEV_DATA_DIR` | | `~/.jev-agent/data/antigravity` | Where the Antigravity plugin stores per-conversation evidence. |

---

## Using it

**Pi**

- Compaction is automatic: whenever Pi compacts (on its threshold, or via `/compact`), the extension asks Jev first.
- `/jev-compact-status` shows the latest decision: tool calls kept, truncated, or dropped, and the estimated tokens saved. When Jev keeps everything, it reports `Result: Jev kept all, Pi native compaction used`.
- `/jev <text or JSON>` runs a routing smoke test, and the `jev_route` tool lets the model route by itself.

**Codex**

- Compaction is automatic through save-token-jev: `PreCompact` scores the context before Codex compacts, and `SessionStart(source="compact")` restores the retained verbatim context right after.

**Claude Code and Codex routing**

- The global rule tells the agent to announce `JevRouter: routing the next step` at a meaningful choice, call the shared runtime, and report the decision and its confidence.

**Antigravity**

- Tool evidence is recorded after each tool call, and a `[Jev Evidence Recall]` block is injected before each model invocation. Evidence is stored per conversation under `JEV_DATA_DIR`, capped at 1,000 characters of output and 500 characters of arguments per call, and redacted.

---

## Verification status

| Host / feature | Status | Evidence |
| :--- | :--- | :--- |
| Automated test suite | ✅ passing | `npm test`: retention engine, Pi adapter, Antigravity plugin, deploy scripts |
| Shared runtime `doctor` / `route` | ✅ live-tested | Synthetic requests against a live endpoint |
| Pi: extensions load | ✅ real host | Both extensions discovered by Pi RPC (`get_commands`) |
| Pi: real compaction calls Jev | ✅ real host | Pi RPC session: Jev was invoked, kept all 8 tool calls, and Pi's native compaction ran |
| Pi: Jev drop/truncate on a real host | ⏳ not yet observed | Jev has not chosen to drop or truncate in a live run yet; this path is covered by automated tests |
| Pi: TUI display of `/jev-compact-status` | ✅ real host | Checked by hand in the interactive Pi TUI; the output displays correctly |
| Antigravity: evidence recall | ✅ real host | Live conversation: 60 evidence records captured (0 fallbacks), recall injected, credentials redacted |
| Antigravity: router skill | 🟡 loaded | Listed in the Antigravity Customizations panel; routing verified only with synthetic inputs |
| Codex: compaction hooks | 🟡 synthetic | Synthetic `PreCompact` / `SessionStart(compact)` round-trip; a real `/compact` has not been run |
| Claude Code / Codex: routing | 🟡 synthetic | Live route through the shared runtime with synthetic candidates |

Legend: ✅ verified · 🟡 verified with synthetic inputs only · ⏳ pending

---

## Repository layout

```
packages/
  runtime/              shared runtime: jev-agent CLI + JevRouter / save-token-jev launchers
  core/                 host-agnostic retention engine (evidence → Jev plan → apply)
  pi-adapter/           Pi compaction extension
  pi-router/            Pi jev_route tool and /jev command
  antigravity-plugin/   Antigravity evidence recall plugin (PostToolUse / PreInvocation)
  antigravity-router/   Antigravity jev-router skill plugin
  claude-code/          jevrouter skill + CLAUDE.md routing rule
  codex/                jevrouter skill + AGENTS.md routing rule + hooks.json template
scripts/                setup, deploy (per host, with backup), doctor
tests/                  automated tests (live smoke tests skip without JEV_API_URL and a key)
docs/                   architecture and verification notes
```

---

## Uninstall

Every deploy writes a backup to `~/.jev-agent/backups/<timestamp>/` first. To roll back a host, delete the files listed above for that host and restore them from the latest backup. Remove the routing-rule block between the `jev-agent:global-routing-v1` markers in `CLAUDE.md` or `AGENTS.md`. Delete the key file separately.

---

## Security notes

- The API key is read from a file outside the repository, and no adapter writes it to a prompt, argument, log, or evidence file.
- Stored evidence and error messages are redacted: API keys, tokens, passwords, and `Authorization: Bearer|Basic …` credentials.
- Transcript files are read with bounded reads: only the tail of a transcript and the head of a step output are loaded into memory.
- The routing integrations never execute a capability on their own.

If you find a security issue, please open a private security advisory instead of a public issue.

---

## Upstream projects

This project builds on two MIT-licensed projects, which are fetched at pinned commits during `npm run setup`:

- **[JevRouter](https://github.com/BillionsBobby/JevRouter)** (`f944acb`): decision-only capability routing with Jev.
- **[save-token-jev](https://github.com/IAmUnbounded/save-token-jev-clean)** (`a700735`): Jev-guided context compaction. Upstream also supports Claude Code compaction, OpenCode, and the Anthropic API. This repository currently deploys its Codex integration only.

## License

[MIT](LICENSE). Upstream projects keep their own licenses.
