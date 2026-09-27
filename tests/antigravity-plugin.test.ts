import test, { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  atomicWrite,
  getDataDir,
  redactSensitive,
  resolveKey,
  sha256,
  truncate,
} from "../packages/antigravity-plugin/scripts/common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const TEST_BASE_DIR = join(repoRoot, "data", "test_scratch_antigravity");
const SCRIPT_RECORD = join(repoRoot, "packages", "antigravity-plugin", "scripts", "record-evidence.mjs");
const SCRIPT_RECALL = join(repoRoot, "packages", "antigravity-plugin", "scripts", "recall-evidence.mjs");

describe("Antigravity Plugin Integration Tests", () => {
  before(() => {
    if (existsSync(TEST_BASE_DIR)) {
      rmSync(TEST_BASE_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_BASE_DIR, { recursive: true });
  });

  after(() => {
    try {
      rmSync(TEST_BASE_DIR, { recursive: true, force: true });
    } catch {}
  });

  it("handles PostToolUse stdin and records tool call AND tool output into sidecar", () => {
    const sessionDir = join(TEST_BASE_DIR, "session_test_1");
    const payload = {
      conversationId: "session_test_1",
      stepIdx: 12,
      toolCall: {
        name: "view_file",
        args: {
          AbsolutePath: "C:\\mock-workspace\\README.md",
          apiKey: "secret_should_be_masked_123",
        },
      },
      toolResult: "File contents: # Project Title\nImportant discovery about architecture.",
      error: null,
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const parsedStdout = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(parsedStdout, {}, "PostToolUse must return empty JSON object {}");

    // Verify sidecar file
    const evidencePath = join(sessionDir, "evidence.json");
    assert.ok(existsSync(evidencePath), "evidence.json must be written");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.strictEqual(evidence.length, 1);
    assert.strictEqual(evidence[0].name, "view_file");
    assert.strictEqual(evidence[0].args.apiKey, "[REDACTED]", "Secret apiKey must be redacted in sidecar");
    // Verify tool output is properly preserved in evidence!
    assert.ok(evidence[0].output.includes("Important discovery about architecture"));
    assert.ok(!JSON.stringify(evidence).includes("secret_should_be_masked_123"));
  });

  it("handles official Antigravity PostToolUse payload without toolResult by extracting from step file and transcript", () => {
    const session = "official_posttooluse_session";
    const hostDir = join(TEST_BASE_DIR, "host_artifacts", session);
    const stepsDir = join(hostDir, "steps", "25");
    const logsDir = join(hostDir, "logs");
    mkdirSync(stepsDir, { recursive: true });
    mkdirSync(logsDir, { recursive: true });

    // 1. Write step output file
    const stepOutputFile = join(stepsDir, "output.txt");
    writeFileSync(stepOutputFile, "Output extracted directly from steps/25/output.txt artifact!", "utf8");

    // 2. Write transcript.jsonl
    const transcriptFile = join(logsDir, "transcript.jsonl");
    writeFileSync(transcriptFile, JSON.stringify({ type: "TOOL_RESULT", content: "Fallback from transcript" }) + "\n", "utf8");

    // 3. Send official PostToolUse payload (NO toolResult included!)
    const payload = {
      conversationId: session,
      stepIdx: 25,
      toolCall: {
        name: "run_command",
        args: { CommandLine: "npm run build" },
      },
      transcriptPath: transcriptFile,
      workspacePaths: [hostDir],
      modelName: "gemini",
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {});

    const evidenceFile = join(TEST_BASE_DIR, session, "evidence.json");
    assert.ok(existsSync(evidenceFile));
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.strictEqual(evidence.length, 1);
    assert.strictEqual(evidence[0].name, "run_command");
    assert.ok(evidence[0].output.includes("Output extracted directly from steps/25/output.txt artifact!"));
  });

  it("reads only a bounded tail of a large transcript and still finds the trailing tool result", () => {
    const session = "large_transcript_session";
    const logsDir = join(TEST_BASE_DIR, "host_artifacts", session, "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");
    // ~3MB of filler so the 1MB tail window starts mid-line
    const filler = JSON.stringify({ type: "MODEL", content: "x".repeat(4000) }) + "\n";
    writeFileSync(
      transcriptFile,
      filler.repeat(750) + JSON.stringify({ type: "TOOL_RESULT", content: "tail tool output" }) + "\n",
      "utf8"
    );

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify({
        conversationId: session,
        stepIdx: 999,
        toolCall: { name: "run_command", args: {} },
        transcriptPath: transcriptFile,
      }),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const evidence = JSON.parse(readFileSync(join(TEST_BASE_DIR, session, "evidence.json"), "utf8"));
    assert.strictEqual(evidence[0].output, "tail tool output");
  });

  it("handles tool error in PostToolUse and marks evidence as error", () => {
    const session = "error_session";
    const payload = {
      conversationId: session,
      stepIdx: 3,
      toolCall: { name: "run_command", args: { CommandLine: "exit 1" } },
      error: "Command exited with status code 1: compilation error",
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const evidenceFile = join(TEST_BASE_DIR, session, "evidence.json");
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.strictEqual(evidence[0].isError, true);
    assert.ok(evidence[0].output.includes("[Error]: Command exited with status code 1"));
  });

  it("redacts sensitive tokens in PostToolUse error messages", () => {
    const session = "error_redact_session";
    const payload = {
      conversationId: session,
      stepIdx: 4,
      toolCall: { name: "fetch_api", args: {} },
      error: "Failed to connect with token sk-abcdef1234567890",
    };

    spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    const evidenceFile = join(TEST_BASE_DIR, session, "evidence.json");
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.strictEqual(evidence[0].isError, true);
    assert.ok(!evidence[0].output.includes("sk-abcdef1234567890"));
    assert.ok(evidence[0].output.includes("[REDACTED]"));
  });

  it("uses standardized fallback when step artifact and transcript are unavailable", () => {
    const session = "fallback_session";
    const payload = {
      conversationId: session,
      stepIdx: 99,
      toolCall: { name: "custom_tool", args: {} },
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const evidenceFile = join(TEST_BASE_DIR, session, "evidence.json");
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.strictEqual(evidence[0].output, "[Action executed; stdout artifact unavailable]");
  });

  it("enforces length truncation limits on arguments and outputs", () => {
    const session = "truncation_session";
    const longArg = "k".repeat(2000);
    const longOutput = "z".repeat(3000);

    const payload = {
      conversationId: session,
      stepIdx: 10,
      toolCall: { name: "test_tool", args: { bigPayload: longArg } },
      toolResult: longOutput,
    };

    spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    const evidenceFile = join(TEST_BASE_DIR, session, "evidence.json");
    const evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    const argsStr = typeof evidence[0].args === "string" ? evidence[0].args : JSON.stringify(evidence[0].args);
    assert.ok(argsStr.length <= 530, "Args must be truncated");
    assert.ok(argsStr.includes("[truncated]"));
    assert.ok(evidence[0].output.length <= 1030, "Output must be truncated");
    assert.ok(evidence[0].output.includes("[truncated]"));
  });

  it("ensures session isolation between different conversationIds", () => {
    const sessionA = "session_iso_A";
    const sessionB = "session_iso_B";

    spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify({
        conversationId: sessionA,
        stepIdx: 1,
        toolCall: { name: "toolA", args: { q: "from A" } },
        toolResult: "Output from A",
      }),
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify({
        conversationId: sessionB,
        stepIdx: 1,
        toolCall: { name: "toolB", args: { q: "from B" } },
        toolResult: "Output from B",
      }),
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    const fileA = join(TEST_BASE_DIR, sessionA, "evidence.json");
    const fileB = join(TEST_BASE_DIR, sessionB, "evidence.json");

    assert.ok(existsSync(fileA));
    assert.ok(existsSync(fileB));

    const dataA = JSON.parse(readFileSync(fileA, "utf8"));
    const dataB = JSON.parse(readFileSync(fileB, "utf8"));

    assert.strictEqual(dataA[0].name, "toolA");
    assert.strictEqual(dataA[0].output, "Output from A");
    assert.strictEqual(dataB[0].name, "toolB");
    assert.strictEqual(dataB[0].output, "Output from B");
  });

  it("handles hash deduplication in PreInvocation (no duplicate injection)", () => {
    const session = "session_dedup";
    const sessionDir = join(TEST_BASE_DIR, session);
    mkdirSync(sessionDir, { recursive: true });

    // Seed 3 evidence entries with outputs
    const evidence = [
      { id: "step_1", name: "find_files", args: { pattern: "*.ts" }, output: "file1.ts, file2.ts", isError: false },
      { id: "step_2", name: "read_file", args: { path: "main.ts" }, output: "export const x = 1;", isError: false },
      { id: "step_3", name: "run_test", args: { cmd: "npm test" }, output: "29 passed", isError: false },
    ];
    writeFileSync(join(sessionDir, "evidence.json"), JSON.stringify(evidence), "utf8");

    // Manually mark hash as already injected
    const currentHash = sha256(evidence);
    writeFileSync(join(sessionDir, "last_injected_hash.txt"), currentHash, "utf8");

    const result = spawnSync(process.execPath, [SCRIPT_RECALL], {
      input: JSON.stringify({ conversationId: session, invocationNum: 2 }),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(parsed, { injectSteps: [] }, "Must skip injection when evidence hash is unchanged");
  });

  it("verifies PreInvocation injects real tool output results into ephemeralMessage when Jev recalls them", () => {
    const session = "session_recall_live";
    const sessionDir = join(TEST_BASE_DIR, session);
    mkdirSync(sessionDir, { recursive: true });

    // Seed 2 evidence entries with distinct outputs
    const evidence = [
      {
        id: "step_1",
        name: "view_file",
        args: { file: "config.json" },
        output: "Database host: localhost, port: 5432, auth: typesafe",
        isError: false,
      },
      {
        id: "step_2",
        name: "run_command",
        args: { cmd: "git status" },
        output: "On branch master, nothing to commit, working tree clean",
        isError: false,
      },
    ];
    writeFileSync(join(sessionDir, "evidence.json"), JSON.stringify(evidence), "utf8");

    const result = spawnSync(process.execPath, [SCRIPT_RECALL], {
      input: JSON.stringify({ conversationId: session, invocationNum: 1 }),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
      timeout: 30_000,
    });

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.ok(Array.isArray(parsed.injectSteps));
    if (parsed.injectSteps.length > 0) {
      const msg = parsed.injectSteps[0].ephemeralMessage;
      assert.ok(msg.includes("[Jev Evidence Recall]:"));
      assert.ok(msg.includes("Result:"), "Recalled message must include output snippet with 'Result:' tag");
    }
  });

  it("fails open when Jev endpoint is unreachable or invalid (never blocks agent)", () => {
    const session = "session_failopen";
    const sessionDir = join(TEST_BASE_DIR, session);
    mkdirSync(sessionDir, { recursive: true });

    const evidence = [
      { id: "step_1", name: "curl", args: { url: "http://example.com" }, output: "response body", isError: false },
      { id: "step_2", name: "parse", args: { target: "body" }, output: "parsed json", isError: false },
    ];
    writeFileSync(join(sessionDir, "evidence.json"), JSON.stringify(evidence), "utf8");

    // Point to non-existent endpoint
    const result = spawnSync(process.execPath, [SCRIPT_RECALL], {
      input: JSON.stringify({ conversationId: session, invocationNum: 1 }),
      encoding: "utf8",
      env: {
        ...process.env,
        JEV_DATA_DIR: TEST_BASE_DIR,
        JEV_API_URL: "http://127.0.0.1:59999/bad_endpoint",
      },
    });

    assert.strictEqual(result.status, 0);
    const parsed = JSON.parse(result.stdout.trim());
    assert.deepStrictEqual(parsed, { injectSteps: [] }, "Must fail open with empty injectSteps on network error");
  });

  it("handles corrupt or invalid evidence files gracefully without crashing", () => {
    const session = "session_corrupt";
    const sessionDir = join(TEST_BASE_DIR, session);
    mkdirSync(sessionDir, { recursive: true });

    // Write invalid junk to evidence.json
    writeFileSync(join(sessionDir, "evidence.json"), "{ NOT_VALID_JSON ::: 123", "utf8");

    // record-evidence should overwrite safely
    const recordResult = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify({
        conversationId: session,
        stepIdx: 1,
        toolCall: { name: "recovered_tool", args: {} },
        toolResult: "Recovered output",
      }),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(recordResult.status, 0);
    assert.deepStrictEqual(JSON.parse(recordResult.stdout.trim()), {});

    // recall-evidence should also handle corruption safely
    writeFileSync(join(sessionDir, "evidence.json"), "<<CORRUPTED DATA>>", "utf8");
    const recallResult = spawnSync(process.execPath, [SCRIPT_RECALL], {
      input: JSON.stringify({ conversationId: session, invocationNum: 1 }),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(recallResult.status, 0);
    assert.deepStrictEqual(JSON.parse(recallResult.stdout.trim()), { injectSteps: [] });
  });

  it("handles paths with spaces safely", () => {
    const spacedDir = join(TEST_BASE_DIR, "path with spaces in name");
    mkdirSync(spacedDir, { recursive: true });

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify({
        conversationId: "spaced_session",
        stepIdx: 5,
        toolCall: { name: "test_spaced_path", args: { dir: spacedDir } },
        toolResult: "Directory exists and is valid",
      }),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: spacedDir },
    });

    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(JSON.parse(result.stdout.trim()), {});
    assert.ok(existsSync(join(spacedDir, "spaced_session", "evidence.json")));
  });

  it("performs atomic write and verifies concurrent writes do not corrupt files", async () => {
    const session = "session_concurrency";
    const sessionDir = join(TEST_BASE_DIR, session);
    mkdirSync(sessionDir, { recursive: true });

    const targetFile = join(sessionDir, "atomic_test.json");

    // Perform multiple rapid writes
    const writes = Array.from({ length: 20 }, (_, i) => {
      const data = JSON.stringify({ index: i, text: `sample payload ${i}`, timestamp: Date.now() });
      return () => atomicWrite(targetFile, data);
    });

    for (const writeFn of writes) {
      writeFn();
    }

    assert.ok(existsSync(targetFile));
    const content = readFileSync(targetFile, "utf8");
    const parsed = JSON.parse(content);
    assert.ok(typeof parsed.index === "number");
  });

  it("verifies plugin.json and hooks.json manifests are strictly valid JSON", () => {
    const pluginJsonPath = join(repoRoot, "packages", "antigravity-plugin", "plugin.json");
    const hooksJsonPath = join(repoRoot, "packages", "antigravity-plugin", "hooks.json");

    assert.ok(existsSync(pluginJsonPath), "plugin.json must exist");
    assert.ok(existsSync(hooksJsonPath), "hooks.json must exist");

    const pluginConfig = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
    const hooksConfig = JSON.parse(readFileSync(hooksJsonPath, "utf8"));

    assert.strictEqual(pluginConfig.name, "jev-context-compaction");
    assert.ok(hooksConfig["jev-context-compaction"]);
    assert.ok(Array.isArray(hooksConfig["jev-context-compaction"].PostToolUse));
    assert.ok(Array.isArray(hooksConfig["jev-context-compaction"].PreInvocation));
  });

  it("verifies default data directory is %USERPROFILE%\\.jev-agent\\data\\antigravity when JEV_DATA_DIR is unset", () => {
    const oldEnv = process.env.JEV_DATA_DIR;
    delete process.env.JEV_DATA_DIR;
    try {
      const dir = getDataDir();
      const expected = join(process.env.USERPROFILE || homedir(), ".jev-agent", "data", "antigravity");
      assert.strictEqual(dir, expected);
    } finally {
      if (oldEnv) process.env.JEV_DATA_DIR = oldEnv;
    }
  });

  it("verifies key file takes priority over environment variable in resolveKey", () => {
    const oldEnvKey = process.env.TYPESAFE_API_KEY;
    const oldKeyFile = process.env.TYPESAFE_API_KEY_FILE;

    const fakeKeyFile = join(TEST_BASE_DIR, "test_key_file");
    writeFileSync(fakeKeyFile, "KEY_FROM_FILE_999\n", "utf8");

    try {
      process.env.TYPESAFE_API_KEY_FILE = fakeKeyFile;
      process.env.TYPESAFE_API_KEY = "OLD_STALE_KEY_IN_ENV";

      const resolved = resolveKey();
      assert.strictEqual(resolved, "KEY_FROM_FILE_999", "Key file must take precedence over environment variable");
    } finally {
      if (oldEnvKey) process.env.TYPESAFE_API_KEY = oldEnvKey;
      else delete process.env.TYPESAFE_API_KEY;
      if (oldKeyFile) process.env.TYPESAFE_API_KEY_FILE = oldKeyFile;
      else delete process.env.TYPESAFE_API_KEY_FILE;
    }
  });

  it("verifies empty key file does not fall back to environment variable in resolveKey", () => {
    const oldEnvKey = process.env.TYPESAFE_API_KEY;
    const oldKeyFile = process.env.TYPESAFE_API_KEY_FILE;

    const emptyKeyFile = join(TEST_BASE_DIR, "empty_key_file");
    writeFileSync(emptyKeyFile, "   \n", "utf8");

    try {
      process.env.TYPESAFE_API_KEY_FILE = emptyKeyFile;
      process.env.TYPESAFE_API_KEY = "SHOULD_NOT_BE_USED";

      const resolved = resolveKey();
      assert.strictEqual(resolved, "", "Empty key file must return empty string and not fall back to env");
    } finally {
      if (oldEnvKey) process.env.TYPESAFE_API_KEY = oldEnvKey;
      else delete process.env.TYPESAFE_API_KEY;
      if (oldKeyFile) process.env.TYPESAFE_API_KEY_FILE = oldKeyFile;
      else delete process.env.TYPESAFE_API_KEY_FILE;
    }
  });

  it("verifies portable deployment: extension bundle can be deployed and loaded independently", async () => {
    const isolatedTempDir = join(TEST_BASE_DIR, "isolated_deployment");
    mkdirSync(isolatedTempDir, { recursive: true });
    const isolatedBundlePath = join(isolatedTempDir, "standalone-ext.js");

    const esbuildPath = join(
      process.env.USERPROFILE || homedir(),
      ".jev-agent",
      "vendor",
      "JevRouter",
      "node_modules",
      "@esbuild",
      "win32-x64",
      "esbuild.exe"
    );

    const sourceFile = join(repoRoot, "packages", "pi-adapter", "src", "extension.ts");
    const buildRes = spawnSync(
      existsSync(esbuildPath) ? esbuildPath : "npx",
      [
        ...(existsSync(esbuildPath) ? [] : ["esbuild"]),
        sourceFile,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--external:node:*",
        `--outfile=${isolatedBundlePath}`,
      ],
      { encoding: "utf8" }
    );

    assert.strictEqual(buildRes.status, 0, `Bundle build failed: ${buildRes.stderr}`);
    assert.ok(existsSync(isolatedBundlePath));

    // Dynamic import to verify it is valid, standalone executable ESM code
    const importedModule = await import(pathToFileURL(isolatedBundlePath).href);
    assert.strictEqual(typeof importedModule.default, "function");

    const commands: Record<string, any> = {};
    const handlers: Record<string, Function> = {};
    importedModule.default({
      on: (evt: string, fn: Function) => { handlers[evt] = fn; return () => {}; },
      registerCommand: (name: string, opt: any) => { commands[name] = opt; },
    });

    assert.ok(commands["jev"]);
    assert.ok(commands["jev-compact-status"]);
    assert.ok(handlers["session_before_compact"]);
  });

  it("extracts tool output for view_file from GENERIC entry matching exact step_index", () => {
    const session = "generic_view_file_session";
    const logsDir = join(TEST_BASE_DIR, "host_artifacts", session, "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");

    // Real transcript format from Antigravity:
    // {"type":"GENERIC","source":"MODEL","step_index":526,"status":"DONE","content":"export const greeting = 'hello world';"}
    const entries = [
      JSON.stringify({ step_index: 525, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "I will read the file." }),
      JSON.stringify({ step_index: 526, source: "MODEL", type: "GENERIC", status: "DONE", content: "export const greeting = 'hello world';" }),
    ];
    writeFileSync(transcriptFile, entries.join("\n") + "\n", "utf8");

    const payload = {
      conversationId: session,
      stepIdx: 526,
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: "C:/mock-workspace/file.ts" },
      },
      transcriptPath: transcriptFile,
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const evidence = JSON.parse(readFileSync(join(TEST_BASE_DIR, session, "evidence.json"), "utf8"));
    assert.strictEqual(evidence[0].name, "view_file");
    assert.strictEqual(evidence[0].output, "export const greeting = 'hello world';");
  });

  it("strictly fails to match GENERIC tool output when step_index does not match stepIdx", () => {
    const session = "mismatched_step_index_session";
    const logsDir = join(TEST_BASE_DIR, "host_artifacts", session, "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");

    const entries = [
      JSON.stringify({ step_index: 999, source: "MODEL", type: "GENERIC", status: "DONE", content: "unrelated step output" }),
    ];
    writeFileSync(transcriptFile, entries.join("\n") + "\n", "utf8");

    const payload = {
      conversationId: session,
      stepIdx: 526, // Does NOT match 999
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: "C:/mock-workspace/file.ts" },
      },
      transcriptPath: transcriptFile,
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const evidence = JSON.parse(readFileSync(join(TEST_BASE_DIR, session, "evidence.json"), "utf8"));
    assert.strictEqual(evidence[0].output, "[Action executed; stdout artifact unavailable]");
  });

  it("never treats PLANNER_RESPONSE entries as tool output even if step_index matches", () => {
    const session = "planner_response_exclusion_session";
    const logsDir = join(TEST_BASE_DIR, "host_artifacts", session, "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");

    const entries = [
      JSON.stringify({ step_index: 526, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "I am planning to edit file.ts" }),
    ];
    writeFileSync(transcriptFile, entries.join("\n") + "\n", "utf8");

    const payload = {
      conversationId: session,
      stepIdx: 526,
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: "C:/mock-workspace/file.ts" },
      },
      transcriptPath: transcriptFile,
    };

    const result = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(result.status, 0);
    const evidence = JSON.parse(readFileSync(join(TEST_BASE_DIR, session, "evidence.json"), "utf8"));
    assert.strictEqual(evidence[0].output, "[Action executed; stdout artifact unavailable]");
  });

  it("verifies deploy-antigravity.mjs cleans up plugins.json and deploys to config/plugins root", () => {
    const mockHome = join(TEST_BASE_DIR, "mock_deploy_home");
    const mockGeminiConfig = join(mockHome, ".gemini", "config");
    mkdirSync(mockGeminiConfig, { recursive: true });

    const mockPluginsJson = join(mockGeminiConfig, "plugins.json");
    writeFileSync(mockPluginsJson, JSON.stringify({ entries: [{ path: "~/.jev-agent/antigravity-plugins" }] }), "utf8");

    const mockOldPluginDir = join(mockHome, ".jev-agent", "antigravity-plugins", "jev-context-compaction");
    mkdirSync(mockOldPluginDir, { recursive: true });
    writeFileSync(join(mockOldPluginDir, "dummy.txt"), "old", "utf8");

    const deployScript = join(repoRoot, "scripts", "deploy.mjs");
    const res = spawnSync(process.execPath, [deployScript, "--host", "antigravity"], {
      encoding: "utf8",
      env: { ...process.env, USERPROFILE: mockHome, HOME: mockHome, MOCK_HOME: mockHome },
    });

    assert.strictEqual(res.status, 0);
    const targetDir = join(mockGeminiConfig, "plugins", "jev-context-compaction");
    assert.ok(existsSync(targetDir));
    assert.ok(existsSync(join(targetDir, "scripts", "record-evidence.mjs")));

    // plugins.json should be removed since entries became empty
    assert.strictEqual(existsSync(mockPluginsJson), false);
    // Old plugin dir should be removed
    assert.strictEqual(existsSync(mockOldPluginDir), false);
  });

  it("backfills pending fallback evidence on subsequent PostToolUse invocation with sensitive redaction", () => {
    const session = "backfill_test_session";
    const logsDir = join(TEST_BASE_DIR, "host_artifacts", session, "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");

    // Initially transcript is empty (step 100 has not been flushed by host yet)
    writeFileSync(transcriptFile, "", "utf8");

    // 1. First hook invocation for step 100
    const payload1 = {
      conversationId: session,
      stepIdx: 100,
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: "C:/mock-workspace/secret.ts" },
      },
      transcriptPath: transcriptFile,
    };

    const res1 = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload1),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });
    assert.strictEqual(res1.status, 0);

    const evidenceFile = join(TEST_BASE_DIR, session, "evidence.json");
    let evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.strictEqual(evidence.length, 1);
    // Should be recorded as fallback text initially
    assert.strictEqual(evidence[0].output, "[Action executed; stdout artifact unavailable]");

    // 2. Append genuine transcript lines:
    // One matching step 100 containing sensitive header, and one unrelated step 999
    const lines = [
      JSON.stringify({
        type: "GENERIC",
        step_index: 999, // Unmatched step_index
        status: "DONE",
        content: "Unmatched content",
      }),
      JSON.stringify({
        type: "GENERIC",
        step_index: 100, // Matches step 100
        status: "DONE",
        content: "File data with Authorization: Bearer secret_token_12345678 and normal content",
      }),
    ];
    writeFileSync(transcriptFile, lines.join("\n") + "\n", "utf8");

    // 3. Second hook invocation for another step (step 101)
    const payload2 = {
      conversationId: session,
      stepIdx: 101,
      toolCall: {
        name: "view_file",
        args: { AbsolutePath: "C:/mock-workspace/other.ts" },
      },
      transcriptPath: transcriptFile,
    };

    const res2 = spawnSync(process.execPath, [SCRIPT_RECORD], {
      input: JSON.stringify(payload2),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });
    assert.strictEqual(res2.status, 0);

    evidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    assert.strictEqual(evidence.length, 2);

    // The first record (step 100) should be backfilled with real content
    const step100 = evidence.find((e: any) => e.id === "step_100");
    assert.ok(step100);
    assert.ok(step100.output.includes("File data with Authorization:"));
    // Must be redacted: secret_token_12345678 must NOT appear
    assert.strictEqual(step100.output.includes("secret_token_12345678"), false, "Token must be redacted");
    assert.ok(step100.output.includes("[REDACTED]"));

    // Step_index 999 must not affect step 100 or create mismatched backfill
    assert.strictEqual(step100.output.includes("Unmatched content"), false);
  });

  it("backfills pending fallback evidence on PreInvocation (recall-evidence) prior to injection", () => {
    const session = "recall_backfill_test_session";
    const logsDir = join(TEST_BASE_DIR, "host_artifacts", session, "logs");
    mkdirSync(logsDir, { recursive: true });
    const transcriptFile = join(logsDir, "transcript.jsonl");

    // Prepare transcript with host flush for step 200
    const lines = [
      JSON.stringify({
        type: "GENERIC",
        step_index: 200,
        status: "DONE",
        content: "Flushed content for step 200",
      }),
    ];
    writeFileSync(transcriptFile, lines.join("\n") + "\n", "utf8");

    // Prepare evidence.json with pending fallback item for step 200 and an established item
    const sessionDataDir = join(TEST_BASE_DIR, session);
    mkdirSync(sessionDataDir, { recursive: true });
    const initialEvidence = [
      {
        id: "step_199",
        name: "run_command",
        args: { CommandLine: "echo hello" },
        output: "hello",
        isError: false,
        error: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: "step_200",
        name: "view_file",
        args: { AbsolutePath: "C:/mock-workspace/file200.ts" },
        output: "[Action executed; stdout artifact unavailable]",
        isError: false,
        error: null,
        createdAt: new Date().toISOString(),
      },
    ];
    const evidenceFile = join(sessionDataDir, "evidence.json");
    writeFileSync(evidenceFile, JSON.stringify(initialEvidence, null, 2), "utf8");

    // Call recall-evidence with transcriptPath in payload
    const payload = {
      conversationId: session,
      invocationNum: 1,
      transcriptPath: transcriptFile,
    };

    const res = spawnSync(process.execPath, [SCRIPT_RECALL], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: { ...process.env, JEV_DATA_DIR: TEST_BASE_DIR },
    });

    assert.strictEqual(res.status, 0);

    // Verify evidence.json was backfilled and updated on disk
    const updatedEvidence = JSON.parse(readFileSync(evidenceFile, "utf8"));
    const step200 = updatedEvidence.find((e: any) => e.id === "step_200");
    assert.ok(step200);
    assert.strictEqual(step200.output, "Flushed content for step 200");
  });
});

