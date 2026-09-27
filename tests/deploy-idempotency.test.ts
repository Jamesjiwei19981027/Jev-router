import test, { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const deployScript = join(repoRoot, "scripts", "deploy.mjs");

describe("Deploy idempotency and content preservation", () => {
  it("preserves content outside markers and remains idempotent across multiple deploys", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "jev-test-home-"));

    try {
      const claudeDir = join(tempHome, ".claude");
      const codexDir = join(tempHome, ".codex");
      const claudeMdPath = join(claudeDir, "CLAUDE.md");
      const agentsMdPath = join(codexDir, "AGENTS.md");

      // Set up initial files with custom content before and after the marker block
      const claudePrefix = "# Custom User Claude Code Rules\n- User rule A\n- User rule B\n\n";
      const claudePostfix = "\n## User Appendices\n- Appendix item 1\n- Appendix item 2\n";
      const initialClaudeContent = `${claudePrefix}<!-- jev-agent:global-routing-v1 -->\nOld claude routing rule text\n<!-- /jev-agent:global-routing-v1 -->\n${claudePostfix}`;

      const codexPrefix = "# Codex Project Settings\n- Guideline 1: keep it simple\n\n";
      const codexPostfix = "\n## Additional Notes\n- Note alpha\n";
      const initialCodexContent = `${codexPrefix}<!-- jev-agent:global-routing-v1 -->\nOld codex routing rule\n<!-- /jev-agent:global-routing-v1 -->\n${codexPostfix}`;

      mkdirSync(claudeDir, { recursive: true });
      mkdirSync(codexDir, { recursive: true });

      writeFileSync(claudeMdPath, initialClaudeContent, "utf8");
      writeFileSync(agentsMdPath, initialCodexContent, "utf8");

      // 1. First deploy
      const runDeploy = (host) => {
        return spawnSync(process.execPath, [deployScript, "--host", host], {
          env: { ...process.env, MOCK_HOME: tempHome },
          encoding: "utf8",
        });
      };

      const resClaude1 = runDeploy("claude-code");
      assert.strictEqual(resClaude1.status, 0, `Claude deploy 1 failed: ${resClaude1.stderr}`);

      const resCodex1 = runDeploy("codex");
      assert.strictEqual(resCodex1.status, 0, `Codex deploy 1 failed: ${resCodex1.stderr}`);

      // Verify content after 1st deploy
      const claude1 = readFileSync(claudeMdPath, "utf8");
      const codex1 = readFileSync(agentsMdPath, "utf8");

      assert.ok(claude1.startsWith(claudePrefix), "CLAUDE.md prefix must be untouched");
      assert.ok(claude1.endsWith(claudePostfix), "CLAUDE.md postfix must be untouched");
      assert.ok(claude1.includes("<!-- jev-agent:global-routing-v1 -->"));
      assert.ok(claude1.includes("<!-- /jev-agent:global-routing-v1 -->"));
      assert.ok(!claude1.includes("Old claude routing rule text"), "Old rule should be replaced");

      assert.ok(codex1.startsWith(codexPrefix), "AGENTS.md prefix must be untouched");
      assert.ok(codex1.endsWith(codexPostfix), "AGENTS.md postfix must be untouched");
      assert.ok(codex1.includes("<!-- jev-agent:global-routing-v1 -->"));
      assert.ok(codex1.includes("<!-- /jev-agent:global-routing-v1 -->"));
      assert.ok(!codex1.includes("Old codex routing rule"), "Old rule should be replaced");

      // 2. Second deploy (Idempotency test)
      const resClaude2 = runDeploy("claude-code");
      assert.strictEqual(resClaude2.status, 0, `Claude deploy 2 failed: ${resClaude2.stderr}`);

      const resCodex2 = runDeploy("codex");
      assert.strictEqual(resCodex2.status, 0, `Codex deploy 2 failed: ${resCodex2.stderr}`);

      const claude2 = readFileSync(claudeMdPath, "utf8");
      const codex2 = readFileSync(agentsMdPath, "utf8");

      assert.strictEqual(claude2, claude1, "Second deploy must produce identical CLAUDE.md (idempotent)");
      assert.strictEqual(codex2, codex1, "Second deploy must produce identical AGENTS.md (idempotent)");

      // Verify that markers are not duplicated
      const countClaudeMarkers = (claude2.match(/<!-- jev-agent:global-routing-v1 -->/g) || []).length;
      assert.strictEqual(countClaudeMarkers, 1, "Only one opening marker must exist");

      const countCodexMarkers = (codex2.match(/<!-- jev-agent:global-routing-v1 -->/g) || []).length;
      assert.strictEqual(countCodexMarkers, 1, "Only one opening marker must exist");
    } finally {
      try {
        rmSync(tempHome, { recursive: true, force: true });
      } catch {}
    }
  });
});
