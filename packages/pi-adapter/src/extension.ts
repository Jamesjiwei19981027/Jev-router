import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { JevRetentionEngine, WindowsJevTransport } from "../../core/src/index.ts";
import { PiHostAdapter } from "./adapter.ts";
import type { PiCompactionStats, PiSnapshot } from "./types.ts";

interface ExtensionContext {
  ui: {
    notify: (msg: string, level?: "info" | "warning" | "error") => void;
  };
}

interface ExtensionAPI {
  on(event: string, handler: (event: any) => Promise<any> | any): () => void;
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }): void;
  registerTool?(tool: any): void;
  exec?(cmd: string, args: string[], opts?: any): Promise<{ code: number; stdout: string; stderr: string }>;
}

let lastCompactionStats: PiCompactionStats | null = null;

function getJevRouteRunner(): string {
  const home = process.env.USERPROFILE || homedir();
  return join(home, ".jev-agent", "bin", "jevrouter-route.mjs");
}

export default function jevContextCompactionExtension(pi: ExtensionAPI) {
  const adapter = new PiHostAdapter();
  const transport = new WindowsJevTransport();
  const engine = new JevRetentionEngine(transport);

  // Hook into Pi's native compaction lifecycle
  pi.on("session_before_compact", async (event: any) => {
    try {
      // Pass the real Pi SessionBeforeCompactEvent into adapter.capture
      const snapshot: PiSnapshot = await adapter.capture(event);
      const evidence = adapter.toEvidence(snapshot);

      // If no tool evidence exists or all evidence is pinned, allow Pi's native compaction
      const unpinned = evidence.filter((e) => !e.pinned);
      if (unpinned.length === 0) {
        return; // Fallback to native compaction
      }

      // Generate retention plan using Jev
      const plan = await engine.planRetention(evidence);
      const result = await adapter.apply(snapshot, plan);
      lastCompactionStats = result.stats;

      // Fail-open guarantee:
      // If plan keeps everything without savings, allow Pi's native compaction
      if (result.stats.toolCallsDropped === 0 && result.stats.toolCallsTruncated === 0) {
        result.stats.fallback = "native";
        return;
      }

      // Return a complete, valid CompactionResult for Pi sessionManager
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: snapshot.firstKeptEntryId || event.preparation?.firstKeptEntryId || "",
          tokensBefore: snapshot.tokensBefore,
          estimatedTokensAfter: result.stats.tokensAfter,
          usage: {
            input: snapshot.tokensBefore,
            output: Math.ceil(result.summary.length / 4),
            totalTokens: snapshot.tokensBefore + Math.ceil(result.summary.length / 4),
          },
          details: {
            jevModel: plan.model,
            jevProvider: plan.provider,
            decisions: plan.decisions,
            stats: result.stats,
          },
        },
      };
    } catch {
      // Fail-open: Never disrupt Pi's native compaction on error
      return;
    }
  });

  // Register /jev-compact-status to inspect context retention metrics
  pi.registerCommand("jev-compact-status", {
    description: "Display latest Jev context retention metrics and compaction decisions",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!lastCompactionStats) {
        ctx.ui.notify(
          "Jev Context Compaction: No compaction events recorded in current session yet.",
          "info"
        );
        return;
      }
      const s = lastCompactionStats;
      const fallbackLine = s.fallback === "native" ? `\nResult: Jev kept all, Pi native compaction used` : "";
      const msg = `Jev Context Status [${s.timestamp.slice(11, 19)}]:
- Provider / Model: ${s.provider} (${s.model})
- Tool Calls: ${s.toolCallsBefore} total (${s.toolCallsKept} kept, ${s.toolCallsTruncated} truncated, ${s.toolCallsDropped} dropped)
- Tokens: ~${s.tokensBefore} -> ~${s.tokensAfter} (Saved: ~${s.savedTokens} tokens)
- Chars: ${s.charsBefore} -> ${s.charsAfter} (Saved: ${s.savedChars} chars)${fallbackLine}`;
      ctx.ui.notify(msg, "info");
    },
  });

  // Provide /jev command with reliable stdin input handling
  pi.registerCommand("jev", {
    description: "Run a live Jev capability routing test without auto-executing candidate",
    handler: async (args: string, ctx: ExtensionContext) => {
      const runner = getJevRouteRunner();
      const text = args.trim();
      let request = text || "Choose a read-only capability for a public lookup";
      let candidates = [
        { name: "search", description: "Find public sources" },
        { name: "summarize", description: "Summarize provided sources" },
      ];

      if (text.startsWith("{")) {
        try {
          const parsed = JSON.parse(text);
          request = parsed.request || request;
          candidates = parsed.candidates || candidates;
        } catch {
          ctx.ui.notify("Invalid JSON input for /jev: failed to parse JSON arguments", "warning");
          return;
        }
      }

      try {
        const payload = JSON.stringify({ request, candidates });
        // Use spawnSync with stdin input to avoid limitations of stdio: ignore in pi.exec
        const result = spawnSync(process.execPath, [runner, "route", "--stdin"], {
          input: payload,
          encoding: "utf8",
          timeout: 30_000,
        });

        if (result.error) {
          ctx.ui.notify(`Jev Route process error: ${result.error.message}`, "error");
          return;
        }

        if (result.status !== 0) {
          const errDetail = (result.stderr || result.stdout || "").trim() || `Process exited with code ${result.status}`;
          ctx.ui.notify(`Jev Route failed (code ${result.status}): ${errDetail.slice(0, 150)}`, "warning");
          return;
        }

        if (result.stdout) {
          const jsonStart = result.stdout.indexOf("{");
          if (jsonStart !== -1) {
            try {
              const data = JSON.parse(result.stdout.slice(jsonStart));
              if (data.error) {
                const errText = typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error);
                ctx.ui.notify(`Jev Route error: ${errText.slice(0, 150)}`, "warning");
                return;
              }
              const selected = data.decision?.selected || data.decision?.jev_choice || "unknown";
              const candidate = data.decision?.candidates?.find((c: any) => c.id === selected || c.name === selected);
              const confidence = typeof candidate?.jev_confidence === "number" ? candidate.jev_confidence : "N/A";
              ctx.ui.notify(`Jev Route: Selected candidate "${selected}" (confidence: ${confidence}). NOTE: Capability selected only; execution: not_started (never executed automatically).`, "info");
              return;
            } catch {}
          }
        }
        ctx.ui.notify(`Jev Route returned non-JSON output: ${(result.stdout || "empty output").slice(0, 100)}`, "warning");
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Jev Route exception: ${errMsg.slice(0, 100)}`, "warning");
      }
    },
  });
}
