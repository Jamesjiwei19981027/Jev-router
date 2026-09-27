import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CANDIDATE = Type.Object({
  name: Type.String({ description: "Exact capability name available to Pi" }),
  description: Type.String({ description: "What this capability can do" }),
});

const ROUTE_PARAMS = Type.Object({
  request: Type.String({ description: "The current task or next-step question" }),
  candidates: Type.Array(CANDIDATE, { minItems: 2, description: "At least two available capabilities" }),
});

function wrapperPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (!home) throw new Error("USERPROFILE is not available");
  return join(home, ".jev-agent", "bin", "jevrouter-route.mjs");
}

async function route(pi: ExtensionAPI, request: string, candidates: Array<{ name: string; description: string }>) {
  const result = await pi.exec(process.execPath, [wrapperPath(), "route", "--request", request, "--candidates", JSON.stringify(candidates)], {
    timeout: 30_000,
    cwd: join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".jev-agent"),
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`Jev routing unavailable: ${detail}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("JevRouter returned malformed JSON");
  }
}

export default function jevRouterExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "jev_route",
    label: "Jev Route",
    description: "Ask live Jev to choose among available capabilities. Decision only; never executes the selected capability.",
    promptSnippet: "Choose the next capability with Jev when two or more real options are available",
    promptGuidelines: [
      "Use exact capability names from the current Pi session.",
      "Do not include JevRouter as a candidate and do not execute the returned selection automatically.",
      "If Jev fails or returns no decision, disclose the fallback and continue with normal Pi reasoning.",
    ],
    parameters: ROUTE_PARAMS,
    async execute(_toolCallId, params) {
      const response = await route(pi, params.request, params.candidates);
      return {
        content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
        details: { provider: "typesafe", decisionOnly: true },
      };
    },
  });

  pi.registerCommand("jev", {
    description: "Route a request with Jev; pass JSON with request and candidates or plain text for a smoke test",
    handler: async (args, ctx) => {
      const text = args.trim();
      let request = text || "Choose the next capability for this task";
      let candidates = [
        { name: "inspect", description: "Inspect the current local context" },
        { name: "search", description: "Find relevant public sources" },
      ];
      if (text.startsWith("{")) {
        try {
          const parsed = JSON.parse(text);
          request = parsed.request;
          candidates = parsed.candidates;
        } catch {
          ctx.ui.notify("Usage: /jev {\"request\":\"...\",\"candidates\":[{\"name\":\"...\",\"description\":\"...\"},{\"name\":\"...\",\"description\":\"...\"}]}", "warning");
          return;
        }
      }
      try {
        const response = await route(pi, request, candidates);
        const answer = response?.decision?.selected ?? response?.decision?.jev_choice ?? "no decision";
        const confidence = response?.decision?.candidates?.find((candidate: { id?: string }) => candidate.id === answer)?.jev_confidence;
        ctx.ui.notify(`Jev: ${answer}${typeof confidence === "number" ? ` (confidence ${confidence})` : ""}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
      }
    },
  });
}
