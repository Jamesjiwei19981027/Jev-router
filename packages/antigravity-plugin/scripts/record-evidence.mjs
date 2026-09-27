import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  atomicWrite,
  backfillPendingEvidence,
  FALLBACK_STDOUT_UNAVAILABLE,
  getDataDir,
  readBounded,
  readJson,
  redactSensitive,
  STEP_OUTPUT_READ_BYTES,
  TRANSCRIPT_TAIL_BYTES,
  truncate,
} from "./common.mjs";

async function main() {
  let rawInput = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  if (!rawInput.trim()) {
    process.stdout.write("{}\n");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    // Malformed input from host: fail safe
    process.stdout.write("{}\n");
    return;
  }

  const conversationId = payload.conversationId || "default_session";
  const stepIdx = payload.stepIdx ?? Date.now();
  const toolName = payload.toolCall?.name || payload.tool_name || payload.name || "unknown_tool";
  const rawArgs = payload.toolCall?.args || payload.tool_input || payload.args || {};
  const toolArgs = redactSensitive(rawArgs);
  const errorMsg = payload.error ? String(payload.error) : null;

  const sanitizedError = errorMsg ? redactSensitive(errorMsg) : null;

  // Extract tool output from host artifacts/transcript (official PostToolUse does not contain toolResult)
  let toolOutput = null;
  let transcriptLines = [];

  // 1. Check step output file in .system_generated/steps/<stepIdx>/output.txt
  if (payload.transcriptPath && existsSync(payload.transcriptPath)) {
    try {
      const transcriptDir = dirname(payload.transcriptPath);
      const possibleStepFiles = [
        join(transcriptDir, "..", "steps", String(stepIdx), "output.txt"),
        join(transcriptDir, "..", "steps", String(Number(stepIdx) + 1), "output.txt"),
        join(transcriptDir, "..", "steps", String(Number(stepIdx) - 1), "output.txt"),
      ];
      for (const stepFile of possibleStepFiles) {
        if (existsSync(stepFile)) {
          const stepText = readBounded(stepFile, STEP_OUTPUT_READ_BYTES, false).text.trim();
          if (stepText) {
            toolOutput = stepText;
            break;
          }
        }
      }

      // 2. If step file not found, parse trailing lines of transcript.jsonl strictly for tool results
      try {
        const tail = readBounded(payload.transcriptPath, TRANSCRIPT_TAIL_BYTES, true);
        transcriptLines = tail.text.trim().split("\n");
        // The first line of a clipped tail is almost certainly partial; discard it.
        if (tail.clipped) transcriptLines.shift();

        if (!toolOutput) {
          for (let i = transcriptLines.length - 1; i >= Math.max(0, transcriptLines.length - 20); i--) {
            const line = transcriptLines[i]?.trim();
            if (!line) continue;
            try {
              const parsedLine = JSON.parse(line);
              // Never treat PLANNER_RESPONSE as tool output
              if (parsedLine.type === "PLANNER_RESPONSE") {
                continue;
              }
              // Retain existing TOOL_RESULT matching
              if ((parsedLine.type === "TOOL_RESULT" || parsedLine.source === "TOOL") && parsedLine.content) {
                toolOutput = parsedLine.content;
                break;
              }
              // Strict exact match for host GENERIC outputs (e.g. view_file)
              if (
                parsedLine.type === "GENERIC" &&
                parsedLine.step_index === Number(stepIdx) &&
                parsedLine.status === "DONE" &&
                parsedLine.content
              ) {
                toolOutput = parsedLine.content;
                break;
              }
            } catch {}
          }
        }
      } catch {}
    } catch {
      // Safe fallback on file read error
    }
  }

  // 3. Fallbacks if transcript/step output file not available or empty
  if (!toolOutput) {
    if (sanitizedError) {
      toolOutput = `[Error]: ${sanitizedError}`;
    } else if (payload.toolResult || payload.result || payload.output) {
      // Backwards-compat / test fallback
      toolOutput = payload.toolResult || payload.result || payload.output;
    } else {
      toolOutput = FALLBACK_STDOUT_UNAVAILABLE;
    }
  }

  const sanitizedOutput = redactSensitive(toolOutput);
  const outputString = truncate(sanitizedOutput, 1000);

  const dataDir = getDataDir();
  const sessionDir = join(dataDir, conversationId);
  const evidenceFile = join(sessionDir, "evidence.json");

  const existingEvidence = readJson(evidenceFile, []);
  const evidenceList = Array.isArray(existingEvidence) ? existingEvidence : [];

  // Reconcile/backfill any previous entries that were recorded before host transcript flush
  if (payload.transcriptPath) {
    backfillPendingEvidence(evidenceList, payload.transcriptPath);
  }

  // Bound arguments: preserve object structure while truncating overly large fields
  let formattedArgs = toolArgs;
  if (toolArgs && typeof toolArgs === "object") {
    const serialized = JSON.stringify(toolArgs);
    if (serialized.length > 500) {
      formattedArgs = Array.isArray(toolArgs) ? [...toolArgs] : { ...toolArgs };
      for (const [k, v] of Object.entries(formattedArgs)) {
        if (typeof v === "string" && v.length > 100) {
          formattedArgs[k] = v.slice(0, 100) + " ...[truncated]";
        }
      }
      if (JSON.stringify(formattedArgs).length > 500) {
        formattedArgs = truncate(JSON.stringify(formattedArgs), 500);
      }
    }
  } else {
    formattedArgs = truncate(toolArgs, 500);
  }

  const newEntry = {
    id: `step_${stepIdx}`,
    name: toolName,
    args: formattedArgs,
    output: outputString,
    isError: Boolean(errorMsg),
    error: sanitizedError,
    createdAt: new Date().toISOString(),
  };

  evidenceList.push(newEntry);

  // Keep bounded evidence to prevent uncontrolled storage growth
  const boundedList = evidenceList.slice(-60);

  try {
    atomicWrite(evidenceFile, JSON.stringify(boundedList, null, 2));
  } catch {
    // Safe fallback: never block host on write error
  }

  // Contract: PostToolUse must return empty JSON object {}
  process.stdout.write("{}\n");
}

main().catch(() => {
  // Always exit cleanly with {} so host execution is never blocked
  process.stdout.write("{}\n");
  process.exit(0);
});
