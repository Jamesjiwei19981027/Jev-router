#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { askJev, atomicWrite, backfillPendingEvidence, getDataDir, readJson, sha256 } from "./common.mjs";

const MIN_EVIDENCE_THRESHOLD = 2;

async function main() {
  let rawInput = "";
  process.stdin.setEncoding("utf8");

  for await (const chunk of process.stdin) {
    rawInput += chunk;
  }

  if (!rawInput.trim()) {
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawInput);
  } catch {
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
    return;
  }

  const conversationId = payload.conversationId || "default_session";
  const dataDir = getDataDir();
  const sessionDir = join(dataDir, conversationId);
  const evidenceFile = join(sessionDir, "evidence.json");
  const hashFile = join(sessionDir, "last_injected_hash.txt");

  const evidenceList = readJson(evidenceFile, []);
  if (payload.transcriptPath && Array.isArray(evidenceList) && evidenceList.length > 0) {
    const modified = backfillPendingEvidence(evidenceList, payload.transcriptPath);
    if (modified) {
      try {
        atomicWrite(evidenceFile, JSON.stringify(evidenceList, null, 2));
      } catch {}
    }
  }

  if (!Array.isArray(evidenceList) || evidenceList.length < MIN_EVIDENCE_THRESHOLD) {
    // Threshold not met: no injection
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
    return;
  }

  const currentHash = sha256(evidenceList);
  let lastInjectedHash = "";
  if (existsSync(hashFile)) {
    try {
      lastInjectedHash = readFileSync(hashFile, "utf8").trim();
    } catch {}
  }

  // Deduplication check: do not reinject identical state
  if (currentHash === lastInjectedHash) {
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
    return;
  }

  // Build Jev State & Questions with real tool outputs
  const recentEvidence = evidenceList.slice(-10);
  const state = {
    context:
      "A coding agent is about to plan its next action. Review recent tool execution evidence and decide which prior actions and key results must be recalled in working memory.",
    evidence: recentEvidence.map((e) => ({
      id: e.id,
      tool: e.name,
      args: e.args,
      outputSnippet: typeof e.output === "string" ? e.output.slice(0, 150) : JSON.stringify(e.output || "").slice(0, 150),
      isError: e.isError,
    })),
  };

  const questions = {};
  for (const item of recentEvidence) {
    questions[`recall_${item.id}`] = {
      type: "noul",
      instructions: `Should prior tool execution ${item.id} (${item.name}) and its output be recalled in working memory for the upcoming turn?`,
    };
  }

  let jevRes;
  try {
    jevRes = await askJev(state, questions, 10_000);
  } catch {
    // Fail-open: on Jev failure or timeout, return empty injectSteps
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
    return;
  }

  const answers = jevRes.answers || {};
  const recalledItems = recentEvidence.filter((e) => {
    const score = answers[`recall_${e.id}`]?.noul;
    return typeof score === "number" && score >= 0.5;
  });

  if (recalledItems.length === 0) {
    // Record current hash to avoid repetitive querying for the same negative state
    try { atomicWrite(hashFile, currentHash); } catch {}
    process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
    return;
  }

  const summaryLines = recalledItems.map((item) => {
    const argsStr = JSON.stringify(item.args || {}).replace(/\s+/g, " ").slice(0, 90);
    const outRaw = typeof item.output === "string" ? item.output : JSON.stringify(item.output || "");
    const outSnippet = outRaw.replace(/\s+/g, " ").slice(0, 160);
    const failTag = item.isError ? " [FAILED]" : "";
    return `- [${item.name} (${argsStr})]: Result: ${outSnippet}${failTag}`;
  });

  const ephemeralMessage = `[Jev Evidence Recall]: Active prior context in this session:\n${summaryLines.join("\n")}`;

  try {
    atomicWrite(hashFile, currentHash);
  } catch {}

  const result = {
    injectSteps: [
      {
        ephemeralMessage,
      },
    ],
  };

  process.stdout.write(JSON.stringify(result) + "\n");
}

main().catch(() => {
  // Fail-open on unhandled errors: never block the agent
  process.stdout.write(JSON.stringify({ injectSteps: [] }) + "\n");
  process.exit(0);
});
