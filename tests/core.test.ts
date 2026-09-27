import test, { describe, it } from "node:test";
import assert from "node:assert";
import {
  JevRetentionEngine,
  type JevAsker,
  type JevQuestions,
  type JevResponse,
  type ToolEvidence,
  computeHash,
  redactSensitive,
  safeJsonStringify,
  ReservedNativeCompactionAdapter,
} from "../packages/core/src/index.ts";

class MockJevAsker implements JevAsker {
  public callCount = 0;
  public lastQuestions: JevQuestions | null = null;
  public lastState: unknown = null;
  public mockAnswers: Record<string, { noul: number }> = {};
  public shouldTimeout = false;
  public shouldError = false;
  public malformed = false;

  async ask(state: unknown, questions: JevQuestions): Promise<JevResponse> {
    this.callCount++;
    this.lastState = state;
    this.lastQuestions = questions;

    if (this.shouldTimeout) {
      throw new Error("Timeout: Jev provider took longer than 15000ms");
    }
    if (this.shouldError) {
      throw new Error("HTTP 500: Internal server error from Jev endpoint");
    }
    if (this.malformed) {
      return { model: "jev-1.13.0", answers: {} } as any; // missing requested questions
    }

    const answers: Record<string, { type: "noul"; noul: number }> = {};
    for (const key of Object.keys(questions)) {
      const configured = this.mockAnswers[key];
      answers[key] = {
        type: "noul",
        noul: configured ? configured.noul : 0.8,
      };
    }

    return {
      model: "jev-1.13.0",
      answers,
      usage: { input_tokens: 100, output_tokens: 20 },
    };
  }
}

function makeSyntheticEvidence(count: number): ToolEvidence[] {
  const list: ToolEvidence[] = [];
  for (let i = 0; i < count; i++) {
    list.push({
      id: `call_${i + 1}`,
      name: `tool_func_${i + 1}`,
      input: { query: `search term ${i + 1}` },
      output: `Result text for tool call ${i + 1} with extensive output details exceeding head limit.`,
      isError: false,
      replayable: true,
      pinned: false,
      createdAt: "2026-09-24T12:00:00.000Z",
    });
  }
  return list;
}

describe("Core Jev Retention Engine", () => {
  it("pins first user/system constraint by default", async () => {
    const asker = new MockJevAsker();
    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 2,
    });

    const evidence = makeSyntheticEvidence(10);
    const plan = await engine.planRetention(evidence);

    const firstDecision = plan.decisions.find((d) => d.id === "call_1");
    assert.ok(firstDecision, "First item decision should exist");
    assert.strictEqual(firstDecision.action, "keep");
    assert.strictEqual(firstDecision.reason, "pinned");
  });

  it("pins recent 6 messages / items by default", async () => {
    const asker = new MockJevAsker();
    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 6,
    });

    const evidence = makeSyntheticEvidence(10);
    const plan = await engine.planRetention(evidence);

    // Items 5 to 10 (indexes 4 to 9) must be pinned
    const recentIds = ["call_5", "call_6", "call_7", "call_8", "call_9", "call_10"];
    for (const id of recentIds) {
      const decision = plan.decisions.find((d) => d.id === id);
      assert.ok(decision, `Decision for ${id} should exist`);
      assert.strictEqual(decision.action, "keep");
      assert.strictEqual(decision.reason, "pinned");
    }
  });

  it("handles drop decision when scores are below threshold", async () => {
    const asker = new MockJevAsker();
    // Configure item 3 to have low scores
    asker.mockAnswers = {
      call_call_3: { noul: 0.1 },
      result_call_3: { noul: 0.05 },
    };

    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 2,
      minCompressionGain: 0.01,
      keepThreshold: 0.5,
    });

    const evidence = makeSyntheticEvidence(6);
    const plan = await engine.planRetention(evidence);

    const decision3 = plan.decisions.find((d) => d.id === "call_3");
    assert.ok(decision3);
    assert.strictEqual(decision3.action, "drop");
    assert.strictEqual(decision3.reason, "call_dropped");
  });

  it("handles truncate_result when keepCall >= threshold but keepResult < threshold", async () => {
    const asker = new MockJevAsker();
    asker.mockAnswers = {
      call_call_3: { noul: 0.8 }, // Call important
      result_call_3: { noul: 0.2 }, // Full output not needed verbatim
    };

    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 2,
      minCompressionGain: 0.01,
      keepThreshold: 0.5,
      truncateHeadChars: 20,
    });

    const evidence = makeSyntheticEvidence(6);
    evidence[2].output = "A".repeat(500); // 500 chars output, truncating to 20 saves 480 chars!
    const plan = await engine.planRetention(evidence);

    const decision3 = plan.decisions.find((d) => d.id === "call_3");
    assert.ok(decision3);
    assert.strictEqual(decision3.action, "truncate_result");
    assert.strictEqual(decision3.reason, "result_truncated");
  });

  it("handles keep when keepResult >= threshold", async () => {
    const asker = new MockJevAsker();
    asker.mockAnswers = {
      call_call_3: { noul: 0.9 },
      result_call_3: { noul: 0.85 },
    };

    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 2,
      minCompressionGain: 0.01,
      keepThreshold: 0.5,
    });

    const evidence = makeSyntheticEvidence(6);
    const plan = await engine.planRetention(evidence);

    const decision3 = plan.decisions.find((d) => d.id === "call_3");
    assert.ok(decision3);
    assert.strictEqual(decision3.action, "keep");
    assert.strictEqual(decision3.reason, "kept");
  });

  it("preserves unreplayable and opaque parts unconditionally", async () => {
    const asker = new MockJevAsker();
    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: false,
      preserveRecentMessages: 0,
    });

    const evidence: ToolEvidence[] = [
      {
        id: "opaque_1",
        name: "custom_opaque_step",
        input: { data: "unknown format" },
        output: "binary blob",
        isError: false,
        replayable: false, // Opaque / cannot be safely re-run
        pinned: false,
      },
    ];

    const plan = await engine.planRetention(evidence);
    const decision = plan.decisions.find((d) => d.id === "opaque_1");
    assert.ok(decision);
    assert.strictEqual(decision.action, "keep");
    assert.strictEqual(decision.reason, "pinned");
    assert.strictEqual(asker.callCount, 0, "Should not even query Jev for unreplayable items");
  });

  it("fails open when Jev times out", async () => {
    const asker = new MockJevAsker();
    asker.shouldTimeout = true;

    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 2,
    });

    const evidence = makeSyntheticEvidence(6);
    const plan = await engine.planRetention(evidence);

    assert.ok(plan.decisions.length === 6);
    for (const d of plan.decisions) {
      assert.strictEqual(d.action, "keep");
    }
    const unpinnedDecision = plan.decisions.find((d) => d.id === "call_3");
    assert.ok(unpinnedDecision?.reason.startsWith("fail_open"));
  });

  it("fails open when Jev returns malformed response", async () => {
    const asker = new MockJevAsker();
    asker.malformed = true;

    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 2,
    });

    const evidence = makeSyntheticEvidence(6);
    const plan = await engine.planRetention(evidence);

    assert.ok(plan.decisions.length === 6);
    for (const d of plan.decisions) {
      assert.strictEqual(d.action, "keep");
    }
  });

  it("preserves minCompressionGain threshold (keeps verbatim if savings negligible)", async () => {
    const asker = new MockJevAsker();
    // Simulate drop score for small item
    asker.mockAnswers = {
      call_call_2: { noul: 0.1 },
      result_call_2: { noul: 0.1 },
    };

    const engine = new JevRetentionEngine(asker, {
      preserveFirstConstraint: true,
      preserveRecentMessages: 1,
      minCompressionGain: 0.5, // High minimum gain requirement (50%)
    });

    const evidence: ToolEvidence[] = [
      {
        id: "call_1",
        name: "big_call",
        input: {},
        output: "x".repeat(1000),
        isError: false,
        replayable: true,
        pinned: true,
      },
      {
        id: "call_2",
        name: "small_call",
        input: {},
        output: "x".repeat(10), // Only saves 10 chars out of 1000+ -> < 1%
        isError: false,
        replayable: true,
        pinned: false,
      },
      {
        id: "call_3",
        name: "recent_call",
        input: {},
        output: "recent",
        isError: false,
        replayable: true,
        pinned: true,
      },
    ];

    const plan = await engine.planRetention(evidence);
    const d2 = plan.decisions.find((d) => d.id === "call_2");
    assert.ok(d2);
    // Because potential savings < 50%, engine keeps it rather than risking context loss
    assert.strictEqual(d2.action, "keep");
    assert.strictEqual(d2.reason, "min_compression_gain_unmet");
  });

  it("generates stable inputHash for deduplication", () => {
    const evidence1 = makeSyntheticEvidence(4);
    const evidence2 = makeSyntheticEvidence(4);
    const hash1 = computeHash(evidence1);
    const hash2 = computeHash(evidence2);
    assert.strictEqual(hash1, hash2);
  });

  it("redacts sensitive authentication tokens and passwords in input preview", () => {
    const payload = {
      tool: "git_push",
      token: "ghp_SECRET_TOKEN_XYZ_123",
      api_key: "sk-abcdef123456",
      nested: {
        password: "SuperSecretPassword123!",
        authorization: "Bearer secret_jwt_token",
        safeField: "safe value",
      },
    };

    const redacted = redactSensitive(payload) as any;
    assert.strictEqual(redacted.token, "[REDACTED]");
    assert.strictEqual(redacted.api_key, "[REDACTED]");
    assert.strictEqual(redacted.nested.password, "[REDACTED]");
    assert.strictEqual(redacted.nested.authorization, "[REDACTED]");
    assert.strictEqual(redacted.nested.safeField, "safe value");

    const str = safeJsonStringify(payload);
    assert.ok(!str.includes("ghp_SECRET_TOKEN_XYZ_123"));
    assert.ok(!str.includes("SuperSecretPassword123!"));
    assert.ok(str.includes("[REDACTED]"));
  });

  it("redacts the credential after an auth scheme in raw Authorization header strings", () => {
    const cases = [
      "Authorization: Bearer secret_jwt_token",
      "authorization=Basic secret_jwt_token",
      'curl -H "Proxy-Authorization: Bearer secret_jwt_token" https://x',
      "request failed with Bearer secret_jwt_token attached",
    ];
    for (const input of cases) {
      const out = redactSensitive(input) as string;
      assert.ok(!out.includes("secret_jwt_token"), `leaked credential: ${out}`);
      assert.ok(out.includes("[REDACTED]"));
    }
  });

  it("verifies ReservedNativeCompactionAdapter strictly returns false in Phase 1", () => {
    const adapter = new ReservedNativeCompactionAdapter();
    assert.strictEqual(adapter.canReplaceNativeCompaction(), false);
  });

  it("WindowsJevTransport rejects empty key file without falling back to TYPESAFE_API_KEY env var", async () => {
    const { WindowsJevTransport } = await import("../packages/core/src/transport.ts");
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    const tempEmptyKey = join(tmpdir(), `empty_key_test_${Date.now()}.txt`);
    writeFileSync(tempEmptyKey, "  \n", "utf8");

    const oldEnvKey = process.env.TYPESAFE_API_KEY;
    const oldKeyFile = process.env.TYPESAFE_API_KEY_FILE;
    try {
      process.env.TYPESAFE_API_KEY_FILE = tempEmptyKey;
      process.env.TYPESAFE_API_KEY = "UNTRUSTED_FALLBACK_KEY";

      const asker = new WindowsJevTransport({ keyFile: tempEmptyKey });
      await assert.rejects(
        () => asker.ask({}, {}),
        /Jev authentication key not configured/
      );
    } finally {
      try { unlinkSync(tempEmptyKey); } catch {}
      if (oldEnvKey) process.env.TYPESAFE_API_KEY = oldEnvKey;
      else delete process.env.TYPESAFE_API_KEY;
      if (oldKeyFile) process.env.TYPESAFE_API_KEY_FILE = oldKeyFile;
      else delete process.env.TYPESAFE_API_KEY_FILE;
    }
  });
});

