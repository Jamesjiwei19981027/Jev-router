import test, { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { PiHostAdapter } from "../packages/pi-adapter/src/adapter.ts";
import jevContextCompactionExtension from "../packages/pi-adapter/src/extension.ts";
import type { PiMessage } from "../packages/pi-adapter/src/types.ts";
import type { RetentionPlan } from "../packages/core/src/types.ts";

function createSyntheticPiMessages(): PiMessage[] {
  return [
    {
      role: "system",
      content: "You are an intelligent coding agent.",
    },
    {
      role: "user",
      content: "Inspect the repository structure and test suite.",
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will list the directory contents." },
        {
          type: "toolCall",
          id: "call_ls_1",
          name: "run_command",
          arguments: { CommandLine: "dir" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_ls_1",
      toolName: "run_command",
      content: [
        {
          type: "text",
          text: "Directory listing of C:\\test-dir:\n- packages\n- tests\n- README.md" + "x".repeat(300),
        },
      ],
      isError: false,
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_redundant_query",
          name: "search_code",
          arguments: { query: "old deprecated helper" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call_redundant_query",
      toolName: "search_code",
      content: [
        {
          type: "text",
          text: "No matches found for old deprecated helper.",
        },
      ],
      isError: false,
    },
    {
      role: "toolResult",
      toolCallId: "orphan_call_999",
      toolName: "external_background_result",
      content: [{ type: "text", text: "Background worker finished task 999" }],
      isError: false,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "I have gathered the repo details. What next?" }],
    },
  ];
}

describe("Pi Host Adapter", () => {
  it("captures Pi messages and extracts tool evidence properly", async () => {
    const adapter = new PiHostAdapter(2);
    const messages = createSyntheticPiMessages();
    const snapshot = await adapter.capture(messages);

    assert.strictEqual(snapshot.messages.length, messages.length);
    const evidence = adapter.toEvidence(snapshot);

    // Should find call_ls_1, call_redundant_query, and orphan_call_999
    assert.strictEqual(evidence.length, 3);

    const lsEvidence = evidence.find((e) => e.id === "call_ls_1");
    assert.ok(lsEvidence);
    assert.strictEqual(lsEvidence.name, "run_command");
    assert.strictEqual(lsEvidence.replayable, true);

    const orphanEvidence = evidence.find((e) => e.id === "orphan_call_999");
    assert.ok(orphanEvidence);
    assert.strictEqual(orphanEvidence.pinned, true, "Orphan tool results must be pinned to avoid deletion");
  });

  it("applies retention plan decisions (drop and truncate) strictly in pairs", async () => {
    const adapter = new PiHostAdapter(2);
    const messages = createSyntheticPiMessages();
    const snapshot = await adapter.capture(messages);

    const plan: RetentionPlan = {
      model: "jev-1.13.0",
      provider: "typesafe",
      createdAt: new Date().toISOString(),
      inputHash: "test_hash",
      decisions: [
        {
          id: "call_ls_1",
          action: "truncate_result",
          keepCall: 0.9,
          keepResult: 0.2,
          reason: "result_truncated",
        },
        {
          id: "call_redundant_query",
          action: "drop",
          keepCall: 0.1,
          keepResult: 0.05,
          reason: "call_dropped",
        },
      ],
    };

    const result = await adapter.apply(snapshot, plan);

    // 1. Verify call_ls_1: call is kept, result message content is truncated
    const truncatedResult = result.messages.find(
      (m) => m.role === "toolResult" && (m as any).toolCallId === "call_ls_1"
    ) as any;
    assert.ok(truncatedResult);
    assert.ok(truncatedResult.content[0].text.includes("[Result truncated by Jev:"));

    // 2. Verify call_redundant_query: both the toolCall in assistant AND the toolResult message are DROPPED!
    const droppedToolCall = result.messages.some((m) => {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        return m.content.some((p: any) => p.type === "toolCall" && p.id === "call_redundant_query");
      }
      return false;
    });
    assert.strictEqual(droppedToolCall, false, "Dropped tool call must not appear in assistant content");

    const droppedToolResult = result.messages.some(
      (m) => m.role === "toolResult" && (m as any).toolCallId === "call_redundant_query"
    );
    assert.strictEqual(droppedToolResult, false, "Dropped tool result message must be deleted");

    // 3. Verify orphan result is strictly preserved!
    const orphanResult = result.messages.find(
      (m) => m.role === "toolResult" && (m as any).toolCallId === "orphan_call_999"
    );
    assert.ok(orphanResult, "Orphan tool result must not be deleted");

    // 4. Verify system and user messages remain intact
    assert.strictEqual(result.messages[0].role, "system");
    assert.strictEqual(result.messages[1].role, "user");

    // 5. Verify stats and structured summary
    assert.strictEqual(result.stats.toolCallsDropped, 1);
    assert.strictEqual(result.stats.toolCallsTruncated, 1);
    assert.ok(result.stats.savedChars > 0);
    assert.ok(result.summary.includes("Jev Context Retention Summary"));
    assert.ok(result.summary.includes("call_redundant_query"));
  });

  it("handles real Pi SessionBeforeCompactEvent shape with messagesToSummarize and firstKeptEntryId", async () => {
    const adapter = new PiHostAdapter(1);

    const realPiEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry_7",
        tokensBefore: 4500,
        messagesToSummarize: [
          { role: "user", content: "Analyze test failure" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Running tests..." },
              { type: "toolCall", id: "tc_1", name: "run_test", arguments: { file: "auth.test.ts" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tc_1",
            toolName: "run_test",
            content: [{ type: "text", text: "FAIL auth.test.ts: expired token" + "x".repeat(1500) }],
            isError: true,
          },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc_2", name: "read_file", args: { file: "auth.ts" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tc_2",
            toolName: "read_file",
            content: [{ type: "text", text: "export function verifyToken() { ... }" }],
            isError: false,
          },
        ],
        fileOps: { read: { "auth.ts": 1 }, written: {}, edited: {} },
        settings: { enabled: true, reserveTokens: 100, keepRecentTokens: 50 },
      },
      branchEntries: [],
      reason: "manual",
      willRetry: false,
    };

    const snapshot = await adapter.capture(realPiEvent);
    assert.strictEqual(snapshot.firstKeptEntryId, "entry_7");
    assert.strictEqual(snapshot.tokensBefore, 4500);
    assert.strictEqual(snapshot.messages.length, 5);

    const evidence = adapter.toEvidence(snapshot);
    assert.strictEqual(evidence.length, 2);
    assert.strictEqual(evidence[0].id, "tc_1");
    assert.strictEqual(evidence[1].id, "tc_2");

    const plan: RetentionPlan = {
      model: "jev-1.13.0",
      provider: "typesafe",
      createdAt: new Date().toISOString(),
      inputHash: "hash_real",
      decisions: [
        { id: "tc_1", action: "truncate_result", keepCall: 0.9, keepResult: 0.1, reason: "result_truncated" },
        { id: "tc_2", action: "keep", keepCall: 0.95, keepResult: 0.9, reason: "kept" },
      ],
    };

    const result = await adapter.apply(snapshot, plan);
    assert.strictEqual(result.stats.toolCallsTruncated, 1);
    assert.strictEqual(result.stats.toolCallsKept, 1);
    assert.strictEqual(result.stats.tokensBefore, 4500);
    assert.ok(result.stats.tokensAfter < 4500, "tokensAfter should be less than tokensBefore after truncation");
    assert.ok(result.stats.savedTokens > 0, "savedTokens must be positive");
    assert.ok(result.summary.includes("Jev Context Retention Summary"));
    assert.ok(result.summary.includes("Token Savings"));
    assert.ok(result.summary.includes("tc_1"));
  });

  it("handles split turn and turnPrefixMessages in Pi SessionBeforeCompactEvent", async () => {
    const adapter = new PiHostAdapter(1);

    const splitEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry_turn_split",
        isSplitTurn: true,
        turnPrefixMessages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc_prefix_1", name: "view_file", arguments: { path: "split.ts" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tc_prefix_1",
            toolName: "view_file",
            content: [{ type: "text", text: "prefix content..." }],
          },
        ],
        messagesToSummarize: [
          { role: "user", content: "history message" },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc_history_1", name: "list_dir", arguments: { dir: "src" } },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tc_history_1",
            toolName: "list_dir",
            content: [{ type: "text", text: "dir contents..." }],
          },
        ],
      },
      branchEntries: [],
      reason: "threshold",
      willRetry: false,
    };

    const snapshot = await adapter.capture(splitEvent);
    assert.strictEqual(snapshot.isSplitTurn, true);
    assert.strictEqual(snapshot.turnPrefixMessages?.length, 2);
    assert.strictEqual(snapshot.messages.length, 3);

    const evidence = adapter.toEvidence(snapshot);
    const ids = evidence.map((e) => e.id);
    assert.ok(ids.includes("tc_prefix_1"), "Evidence must include tool calls from turnPrefixMessages");
    assert.ok(ids.includes("tc_history_1"), "Evidence must include tool calls from messagesToSummarize");

    // Decisions targeting split-turn prefix tool calls must actually be applied to the prefix messages.
    const plan: RetentionPlan = {
      model: "jev-1.13.0",
      provider: "typesafe",
      createdAt: new Date().toISOString(),
      inputHash: "split_hash",
      decisions: [
        { id: "tc_prefix_1", action: "drop", keepCall: 0.1, keepResult: 0.1, reason: "call_dropped" },
        { id: "tc_history_1", action: "truncate_result", keepCall: 0.9, keepResult: 0.2, reason: "result_truncated" },
      ],
    };
    const result = await adapter.apply(snapshot, plan);
    assert.strictEqual(result.turnPrefixMessages.length, 0, "Dropped prefix call and its result must be removed in lockstep");
    assert.ok(!JSON.stringify(result.turnPrefixMessages).includes("tc_prefix_1"));
    assert.strictEqual(result.stats.messagesBefore, 5);
    assert.strictEqual(result.stats.messagesAfter, 3);
    const historyResult = result.messages.find((m: any) => m.role === "toolResult") as any;
    assert.ok(historyResult.content[0].text.includes("[Result truncated by Jev"));
  });

  it("verifies accurate token estimation and prevents character counts from masquerading as tokens", async () => {
    const adapter = new PiHostAdapter(0);

    // Create an event WITHOUT tokensBefore to test estimation formula
    const text1000Chars = "a".repeat(1000);
    const eventWithoutTokens = {
      type: "session_before_compact",
      preparation: {
        messagesToSummarize: [
          { role: "user", content: text1000Chars },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "tc_tok", name: "calc", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "tc_tok",
            toolName: "calc",
            content: [{ type: "text", text: "result text" }],
          },
        ],
      },
    };

    const snapshot = await adapter.capture(eventWithoutTokens);
    // 1000 chars user text + JSON boilerplate ~ 1100 chars -> Math.ceil(1100 / 4) ~ 275 tokens
    assert.ok(snapshot.tokensBefore > 200 && snapshot.tokensBefore < 400, `Expected ~275 tokens, got: ${snapshot.tokensBefore}`);
    assert.notStrictEqual(snapshot.tokensBefore, snapshot.totalChars, "tokensBefore must NOT be equal to character count");

    // Test Pi extension hook return structure
    let registeredCompactionHandler: Function | null = null;
    const mockPi = {
      on(event: string, handler: Function) {
        if (event === "session_before_compact") registeredCompactionHandler = handler;
        return () => {};
      },
      registerCommand() {},
    };

    jevContextCompactionExtension(mockPi as any);
    assert.ok(registeredCompactionHandler);

    // Call the handler with an event that triggers drop/truncate
    const compEvent = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry_1",
        tokensBefore: 500,
        messagesToSummarize: [
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_a", name: "tool_a", arguments: {} },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call_a",
            toolName: "tool_a",
            content: [{ type: "text", text: "x".repeat(1200) }],
          },
        ],
      },
    };

    const compResult = await (registeredCompactionHandler as any)(compEvent);
    if (compResult?.compaction) {
      assert.strictEqual(compResult.compaction.tokensBefore, 500);
      assert.ok(compResult.compaction.usage, "CompactionResult must include usage object");
      assert.strictEqual(compResult.compaction.usage.input, 500);
      assert.ok(compResult.compaction.usage.output > 0);
      assert.ok(compResult.compaction.usage.totalTokens > compResult.compaction.usage.input);
      assert.strictEqual(
        compResult.compaction.estimatedTokensAfter,
        compResult.compaction.details.stats.tokensAfter,
        "estimatedTokensAfter must equal details.stats.tokensAfter"
      );
      assert.ok(
        compResult.compaction.estimatedTokensAfter < compResult.compaction.tokensBefore,
        "estimatedTokensAfter must be less than tokensBefore after compaction"
      );
    }
  });

  it("integrates with real Pi prepareCompaction from @earendil-works/pi-coding-agent", async (t) => {
    let piCompactionPath: string | null = null;
    try {
      const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
      const globalRoot = execSync(`${npmCmd} root -g`, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      const candidate = join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "compaction.js");
      if (existsSync(candidate)) {
        piCompactionPath = candidate;
      }
    } catch {}

    if (!piCompactionPath) {
      t.skip("Pi package (@earendil-works/pi-coding-agent) not found globally");
      return;
    }

    const { prepareCompaction } = await import(
      pathToFileURL(piCompactionPath).href
    );

    const entries = [
      { id: "e1", parentId: null, type: "message", message: { role: "user", content: "hello turn 1" } },
      { id: "e2", parentId: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "search", arguments: { q: "pi" } }] } },
      { id: "e3", parentId: "e2", type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "search", content: [{ type: "text", text: "pi result " + "x".repeat(2000) }] } },
      { id: "e4", parentId: "e3", type: "message", message: { role: "assistant", content: [{ type: "text", text: "I found pi" }] } },
      { id: "e5", parentId: "e4", type: "message", message: { role: "user", content: "hello turn 2" } },
      { id: "e6", parentId: "e5", type: "message", message: { role: "assistant", content: [{ type: "text", text: "turn 2 reply" }] } },
      { id: "e7", parentId: "e6", type: "message", message: { role: "user", content: "hello turn 3" } },
      { id: "e8", parentId: "e7", type: "message", message: { role: "assistant", content: [{ type: "text", text: "turn 3 reply" }] } },
    ];

    const prep = prepareCompaction(entries, { enabled: true, reserveTokens: 10, keepRecentTokens: 5 });
    assert.ok(prep, "prepareCompaction must succeed on valid session graph");
    assert.ok(prep.messagesToSummarize.length > 0);

    const adapter = new PiHostAdapter(1);
    const event = {
      type: "session_before_compact",
      preparation: prep,
      branchEntries: entries,
      reason: "threshold",
      willRetry: false,
    };

    const snapshot = await adapter.capture(event);
    assert.strictEqual(snapshot.firstKeptEntryId, prep.firstKeptEntryId);
    assert.strictEqual(snapshot.tokensBefore, prep.tokensBefore);

    const evidence = adapter.toEvidence(snapshot);
    const searchEvidence = evidence.find((e) => e.id === "c1");
    assert.ok(searchEvidence, "Tool call c1 must be extracted from real preparation.messagesToSummarize");
    assert.strictEqual(searchEvidence.name, "search");
  });

  it("simulates Pi extension registration without interfering with existing jev-router", () => {
    const registeredHandlers: Record<string, Function> = {};
    const registeredCommands: Record<string, any> = {};

    const mockPi = {
      on(event: string, handler: Function) {
        registeredHandlers[event] = handler;
        return () => {};
      },
      registerCommand(name: string, options: any) {
        registeredCommands[name] = options;
      },
    };

    jevContextCompactionExtension(mockPi as any);

    assert.ok(typeof registeredHandlers["session_before_compact"] === "function");
    assert.ok(registeredCommands["jev-compact-status"]);
    assert.ok(registeredCommands["jev"]);

    // Verify existing jev-router.ts file in user profile is still present and preserved!
    const home = process.env.USERPROFILE || homedir();
    const routerPath = join(home, ".pi", "agent", "extensions", "jev-router.ts");
    assert.ok(existsSync(routerPath), "Existing jev-router.ts must not be removed or overwritten");
  });

  it("verifies /jev command handles json, invalid json, and failure without false positives", async () => {
    const registeredCommands: Record<string, any> = {};
    const mockPi = {
      on: () => () => {},
      registerCommand(name: string, options: any) {
        registeredCommands[name] = options;
      },
    };

    jevContextCompactionExtension(mockPi as any);
    const jevHandler = registeredCommands["jev"].handler;

    let notifiedMsg = "";
    let notifiedLevel = "";
    const ctx = {
      ui: {
        notify(msg: string, level: string = "info") {
          notifiedMsg = msg;
          notifiedLevel = level;
        },
      },
    };

    // 1. Invalid JSON args: must warn and not falsely report success
    await jevHandler("{ invalid json string", ctx);
    assert.strictEqual(notifiedLevel, "warning");
    assert.ok(notifiedMsg.includes("Invalid JSON input for /jev"));

    // 2. Valid plain text routing test
    await jevHandler("Choose a tool for testing", ctx);
    assert.strictEqual(notifiedLevel, "info");
    assert.ok(notifiedMsg.includes("Selected candidate"));
    assert.ok(notifiedMsg.includes("execution: not_started (never executed automatically)"));

    // 3. Valid JSON object args
    await jevHandler(JSON.stringify({ request: "Read public web documentation", candidates: [{ name: "search", description: "Search" }] }), ctx);
    assert.strictEqual(notifiedLevel, "info");
    assert.ok(notifiedMsg.includes("Selected candidate"));
    assert.ok(notifiedMsg.includes("NOTE: Capability selected only; execution: not_started"));
  });

  it("handles empty preparation.messagesToSummarize without dumping whole branch", async () => {
    const adapter = new PiHostAdapter(1);
    const event = {
      type: "session_before_compact",
      preparation: {
        firstKeptEntryId: "entry_99",
        tokensBefore: 200,
        messagesToSummarize: [],
      },
      branchEntries: [
        { id: "e1", type: "message", message: { role: "user", content: "should not be included" } },
      ],
    };

    const snapshot = await adapter.capture(event);
    assert.strictEqual(snapshot.messages.length, 0, "messagesToSummarize: [] must yield 0 snapshot messages");
  });

  it("safeJsonStringify preserves full text when limit is not specified", async () => {
    const { safeJsonStringify } = await import("../packages/core/src/utils.ts");
    const longString = "A".repeat(5000);
    const serialized = safeJsonStringify({ data: longString });
    assert.ok(serialized.length > 5000, "safeJsonStringify should not truncate below 1000 when no limit given");
  });

  it("ensures all-kept retention plan yields zero saved tokens and tokensAfter equals tokensBefore", async () => {
    const adapter = new PiHostAdapter(2);
    const messages = createSyntheticPiMessages();
    const snapshot = await adapter.capture({
      type: "session_before_compact",
      preparation: {
        tokensBefore: 60000,
        messagesToSummarize: messages,
      },
    });

    const plan: RetentionPlan = {
      model: "jev-1.13.0",
      provider: "typesafe",
      createdAt: new Date().toISOString(),
      inputHash: "test_all_kept",
      decisions: [
        { id: "call_ls_1", action: "keep", keepCall: 0.9, keepResult: 0.9, reason: "kept" },
        { id: "call_redundant_query", action: "keep", keepCall: 0.85, keepResult: 0.85, reason: "kept" },
      ],
    };

    const result = await adapter.apply(snapshot, plan);
    assert.strictEqual(result.stats.toolCallsDropped, 0);
    assert.strictEqual(result.stats.toolCallsTruncated, 0);
    assert.strictEqual(result.stats.toolCallsKept, 2);
    assert.strictEqual(result.stats.savedTokens, 0, "savedTokens must strictly be 0 when all kept");
    assert.strictEqual(result.stats.tokensAfter, snapshot.tokensBefore, "tokensAfter must equal tokensBefore when all kept");
  });

  it("verifies extension marks fallback as native and notifies when Jev keeps all", async () => {
    const handlers: Record<string, Function> = {};
    const commands: Record<string, any> = {};

    jevContextCompactionExtension({
      on: (evt: string, fn: Function) => { handlers[evt] = fn; return () => {}; },
      registerCommand: (name: string, opt: any) => { commands[name] = opt; },
    });

    const messages: PiMessage[] = [
      { role: "user", content: "inspect code" },
      { role: "assistant", content: [{ type: "toolCall", id: "tc_early", name: "read", arguments: { path: "a.ts" } }] },
      { role: "toolResult", toolCallId: "tc_early", toolName: "read", content: "file content" },
      { role: "assistant", content: [{ type: "text", text: "step 1" }] },
      { role: "user", content: "step 2" },
      { role: "assistant", content: [{ type: "text", text: "step 2" }] },
      { role: "user", content: "step 3" },
      { role: "assistant", content: [{ type: "text", text: "step 3" }] },
      { role: "user", content: "step 4" },
      { role: "assistant", content: [{ type: "text", text: "step 4" }] },
    ];
    const event = {
      type: "session_before_compact",
      preparation: {
        tokensBefore: 55000,
        messagesToSummarize: messages,
      },
    };

    const ret = await handlers["session_before_compact"](event);
    assert.strictEqual(ret, undefined, "Must fallback to native compaction when all kept without drop/truncate");

    let notifiedMsg = "";
    await commands["jev-compact-status"].handler("", {
      ui: {
        notify(msg: string) {
          notifiedMsg = msg;
        },
      },
    });

    assert.strictEqual(notifiedMsg.includes(")}"), false, "Output must not contain ')}'");
    assert.ok(notifiedMsg.includes("Result: Jev kept all, Pi native compaction used"));
  });
});

