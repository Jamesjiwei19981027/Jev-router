import test, { describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { redactSensitive } from "../scripts/common.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(__dirname, "..");

describe("Antigravity Plugin Self-contained Tests", () => {
  it("validates plugin.json exists and has correct format", () => {
    const file = join(pluginRoot, "plugin.json");
    assert.ok(existsSync(file), `Expected ${file} to exist`);
    const json = JSON.parse(readFileSync(file, "utf8"));
    assert.strictEqual(json.name, "jev-context-compaction");
  });

  it("validates hooks.json exists and specifies PostToolUse and PreInvocation", () => {
    const file = join(pluginRoot, "hooks.json");
    assert.ok(existsSync(file), `Expected ${file} to exist`);
    const json = JSON.parse(readFileSync(file, "utf8"));
    assert.ok(json["jev-context-compaction"]);
    assert.ok(json["jev-context-compaction"].PostToolUse);
    assert.ok(json["jev-context-compaction"].PreInvocation);
  });

  it("verifies sensitive data redaction helper", () => {
    const sensitive = {
      api_key: "secret123",
      token: "secretToken",
      authorization: "Bearer secret",
      safe: "public",
    };
    const redacted = redactSensitive(sensitive);
    assert.strictEqual(redacted.api_key, "[REDACTED]");
    assert.strictEqual(redacted.token, "[REDACTED]");
    assert.strictEqual(redacted.authorization, "[REDACTED]");
    assert.strictEqual(redacted.safe, "public");
  });

  it("redacts the credential after an auth scheme in raw Authorization header strings", () => {
    for (const input of [
      "Authorization: Bearer secret_jwt_token",
      'curl -H "Authorization: Basic secret_jwt_token"',
      "sent Bearer secret_jwt_token upstream",
    ]) {
      const out = redactSensitive(input);
      assert.ok(!out.includes("secret_jwt_token"), `leaked credential: ${out}`);
    }
  });
});
