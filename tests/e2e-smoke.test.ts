import test, { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { WindowsJevTransport } from "../packages/core/src/transport.ts";
import { JevRetentionEngine } from "../packages/core/src/engine.ts";
import type { ToolEvidence } from "../packages/core/src/types.ts";

function hasLiveCredentials(): boolean {
  const url = (process.env.JEV_API_URL || process.env.JEV_BASE_URL || "").trim();
  if (!url) return false;

  const home = process.env.USERPROFILE || homedir();
  const keyFile = process.env.TYPESAFE_API_KEY_FILE || join(home, ".jev-agent", "secrets", "typesafe_api_key");
  let key: string | undefined;
  if (existsSync(keyFile)) {
    try {
      key = readFileSync(keyFile, "utf8").trim();
    } catch {}
  }
  key ||= process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  return Boolean(key);
}

describe("Live Smoke Tests (Real Provider Connectivity)", () => {
  it("executes JevRouter live smoke test payload via shared runner without printing secret", (t) => {
    if (!hasLiveCredentials()) {
      t.skip("No JEV_API_URL or API key configured, skipping live smoke tests");
      return;
    }

    const home = process.env.USERPROFILE || homedir();
    const runner = join(home, ".jev-agent", "bin", "jevrouter-route.mjs");
    if (!existsSync(runner)) {
      t.skip("Shared runtime runner not found, skipping live smoke test");
      return;
    }

    const payload = {
      request: "Choose a read-only capability for a public lookup",
      candidates: [
        { name: "search", description: "Find public sources" },
        { name: "summarize", description: "Summarize provided sources" },
      ],
    };

    const result = spawnSync(process.execPath, [runner, "route", "--stdin"], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.strictEqual(result.status, 0, `Process failed: ${result.stderr}`);

    // Parse the output
    const stdout = result.stdout;
    // Find the JSON block in stdout
    const jsonStart = stdout.indexOf("{");
    assert.ok(jsonStart !== -1, "Stdout should contain JSON response");
    const jsonStr = stdout.slice(jsonStart);
    const parsed = JSON.parse(jsonStr);

    // Verify requirements:
    // 1. live provider response received
    assert.strictEqual(parsed.runtime?.provider_response_received, true);

    // 2. model
    assert.strictEqual(parsed.raw_jev?.model, "jev-1.13.0");

    // 3. decision status
    assert.strictEqual(parsed.status, "selected");

    // 4. selected candidate
    const selected = parsed.decision?.selected;
    assert.ok(selected === "search" || selected === "summarize");

    // 5. confidence
    const candidate = parsed.decision?.candidates?.find((c: any) => c.id === selected);
    assert.ok(typeof candidate?.jev_confidence === "number");

    // 6. execution remains not started
    assert.strictEqual(parsed.execution?.enabled, false);
    assert.strictEqual(parsed.execution?.status, "not_started");

    // 7. no secret printed
    assert.ok(!stdout.includes("TYPESAFE_API_KEY="));
    assert.ok(!stdout.includes("Bearer"));
  });

  it("executes WindowsJevTransport live ask directly against systemone endpoint", async (t) => {
    if (!hasLiveCredentials()) {
      t.skip("No JEV_API_URL or API key configured, skipping live smoke tests");
      return;
    }

    const transport = new WindowsJevTransport();
    const state = "Smoke testing connection from jev-context-hosts live test suite.";
    const questions = {
      test_q: {
        type: "noul" as const,
        instructions: "Is this synthetic test question valid?",
      },
    };

    const response = await transport.ask(state, questions);
    assert.ok(response, "Response must not be null");
    assert.strictEqual(response.model, "jev-1.13.0");
    assert.ok(response.answers && response.answers.test_q);
    assert.strictEqual(typeof response.answers.test_q.noul, "number");
  });

  it("executes live JevRetentionEngine compaction planning on synthetic evidence", async (t) => {
    if (!hasLiveCredentials()) {
      t.skip("No JEV_API_URL or API key configured, skipping live smoke tests");
      return;
    }

    const transport = new WindowsJevTransport();
    const engine = new JevRetentionEngine(transport, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 1,
      minCompressionGain: 0.05,
      truncateHeadChars: 30,
    });

    const evidence: ToolEvidence[] = [
      {
        id: "call_init",
        name: "check_env",
        input: { cmd: "node -v" },
        output: "v24.18.0",
        isError: false,
        replayable: true,
        pinned: true,
      },
      {
        id: "call_inspect",
        name: "list_dir",
        input: { dir: "C:\\mock\\project" },
        output: "Extensive directory listing containing temporary log files: " + "X".repeat(500),
        isError: false,
        replayable: true,
        pinned: false,
      },
      {
        id: "call_latest",
        name: "git_status",
        input: {},
        output: "On branch main, working tree clean",
        isError: false,
        replayable: true,
        pinned: true,
      },
    ];

    const plan = await engine.planRetention(evidence, "Optimize context without losing critical environment info.");
    assert.ok(plan);
    assert.strictEqual(plan.model, "jev-1.13.0");
    assert.strictEqual(plan.provider, "typesafe");
    assert.strictEqual(plan.decisions.length, 3);

    // Verify pinned first and last
    const firstDecision = plan.decisions.find((d) => d.id === "call_init");
    assert.strictEqual(firstDecision?.action, "keep");

    const lastDecision = plan.decisions.find((d) => d.id === "call_latest");
    assert.strictEqual(lastDecision?.action, "keep");
  });
});
