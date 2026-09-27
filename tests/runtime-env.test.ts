import test, { describe, it } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const runtimeBinDir = join(repoRoot, "packages", "runtime", "bin");

describe("Runtime environment validation without JEV_API_URL", () => {
  const envWithoutUrl = { ...process.env };
  delete envWithoutUrl.JEV_API_URL;
  delete envWithoutUrl.JEV_BASE_URL;

  it("jev-agent doctor returns JSON error and non-zero exit code when JEV_API_URL is missing", () => {
    const entry = join(runtimeBinDir, "jev-agent.mjs");
    const result = spawnSync(process.execPath, [entry, "doctor"], {
      env: envWithoutUrl,
      encoding: "utf8",
    });

    assert.notStrictEqual(result.status, 0, "Exit code must be non-zero");
    const stdout = (result.stdout || "").trim();
    assert.ok(stdout.length > 0, "Stdout must not be empty");
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.error, "missing_jev_api_url");
  });

  it("jevrouter-route launcher returns JSON error and non-zero exit code when JEV_API_URL is missing", () => {
    const entry = join(runtimeBinDir, "jevrouter-route.mjs");
    const result = spawnSync(process.execPath, [entry, "route", "--stdin"], {
      input: JSON.stringify({ request: "test", candidates: [{ name: "a", description: "a" }, { name: "b", description: "b" }] }),
      env: envWithoutUrl,
      encoding: "utf8",
    });

    assert.notStrictEqual(result.status, 0, "Exit code must be non-zero");
    const stdout = (result.stdout || "").trim();
    assert.ok(stdout.length > 0, "Stdout must not be empty");
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.error, "missing_jev_api_url");
  });

  it("save-token-jev-hook launcher returns JSON error and non-zero exit code when JEV_API_URL is missing", () => {
    const entry = join(runtimeBinDir, "save-token-jev-hook.mjs");
    const result = spawnSync(process.execPath, [entry, "hook", "codex"], {
      env: envWithoutUrl,
      encoding: "utf8",
    });

    assert.notStrictEqual(result.status, 0, "Exit code must be non-zero");
    const stdout = (result.stdout || "").trim();
    assert.ok(stdout.length > 0, "Stdout must not be empty");
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.error, "missing_jev_api_url");
  });
});
