---
name: jev-context-compaction
description: Jev evidence recall plugin for Antigravity. Tracks past tool execution evidence in a dedicated session sidecar and recalls critical context before model invocations.
---

# Jev Evidence Recall for Antigravity

This plugin provides **Jev evidence recall** for Antigravity sessions.

> [!NOTE]
> **Implementation Scope**: This plugin performs evidence tracking and ephemeral context recall via standard Antigravity lifecycle hooks (`PostToolUse` and `PreInvocation`).
> It is officially designated as **Jev evidence recall**. It does **not** claim to replace Antigravity native token compaction.

## How It Works

1. **Evidence Recording (`PostToolUse`)**:
   - Captures tool name, input arguments, and output status.
   - Automatically redacts credentials, access tokens, and secret parameters.
   - Atomically records bounded evidence into the session's isolated sidecar directory under `~/.jev-agent/data/antigravity/<conversationId>/`.

2. **Evidence Recall (`PreInvocation`)**:
   - Activates once the session accumulates sufficient tool evidence.
   - Computes a state hash to guarantee no duplicate recall within the same state.
   - Consults Jev to select high-value evidence items.
   - Injects a concise `ephemeralMessage` into the active session context.
   - Fails open silently if Jev is unreachable or times out, never blocking normal agent operations.
