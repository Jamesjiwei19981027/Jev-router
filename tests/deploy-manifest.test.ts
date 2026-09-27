import test, { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const deployScript = join(repoRoot, "scripts", "deploy.mjs");

describe("Deploy manifest consistency with README specifications", () => {
  it("deploys all hosts to expected paths as documented in README.md", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "jev-manifest-test-"));

    try {
      const result = spawnSync(process.execPath, [deployScript, "--host", "all"], {
        env: { ...process.env, MOCK_HOME: tempHome },
        encoding: "utf8",
      });

      assert.strictEqual(result.status, 0, `Deploy --host all failed: ${result.stderr}`);

      // Expected manifest according to README.md compatibility matrix & quick start:
      // 1. Claude Code
      const claudeSkillDir = join(tempHome, ".claude", "skills", "jevrouter");
      const claudeSkillMd = join(claudeSkillDir, "SKILL.md");
      const claudePluginJson = join(claudeSkillDir, ".claude-plugin", "plugin.json");
      const claudeMd = join(tempHome, ".claude", "CLAUDE.md");

      assert.ok(existsSync(claudeSkillDir), "Claude skill directory must exist");
      assert.ok(existsSync(claudeSkillMd), "Claude SKILL.md must exist");
      assert.ok(existsSync(claudePluginJson), "Claude plugin.json must exist");
      assert.ok(existsSync(claudeMd), "CLAUDE.md must exist");

      // 2. Codex
      const codexSkillDir = join(tempHome, ".codex", "skills", "jevrouter");
      const codexSkillMd = join(codexSkillDir, "SKILL.md");
      const codexHooksJson = join(tempHome, ".codex", "hooks.json");
      const codexAgentsMd = join(tempHome, ".codex", "AGENTS.md");

      assert.ok(existsSync(codexSkillDir), "Codex skill directory must exist");
      assert.ok(existsSync(codexSkillMd), "Codex SKILL.md must exist");
      assert.ok(existsSync(codexHooksJson), "Codex hooks.json must exist");
      assert.ok(existsSync(codexAgentsMd), "Codex AGENTS.md must exist");

      // Verify placeholders in Codex hooks.json are resolved
      const hooksContent = readFileSync(codexHooksJson, "utf8");
      assert.ok(!hooksContent.includes("${RUNTIME_ROOT}"), "Codex hooks.json must not contain unresolved ${RUNTIME_ROOT}");
      assert.ok(hooksContent.includes(".jev-agent"), "Codex hooks.json must point to runtime root");

      // 3. Pi
      const piExtDir = join(tempHome, ".pi", "agent", "extensions");
      const piCompactionExt = join(piExtDir, "jev-context-compaction.ts");
      const piRouterExt = join(piExtDir, "jev-router.ts");

      assert.ok(existsSync(piExtDir), "Pi extensions directory must exist");
      assert.ok(existsSync(piCompactionExt), "Pi jev-context-compaction.ts must exist");
      assert.ok(existsSync(piRouterExt), "Pi jev-router.ts must exist");

      // 4. Antigravity
      const agCompactionDir = join(tempHome, ".gemini", "config", "plugins", "jev-context-compaction");
      const agRouterDir = join(tempHome, ".gemini", "config", "plugins", "jev-router");
      const agCompactionPluginJson = join(agCompactionDir, "plugin.json");
      const agRouterPluginJson = join(agRouterDir, "plugin.json");
      const agRouterSkillMd = join(agRouterDir, "skills", "jev-router", "SKILL.md");

      assert.ok(existsSync(agCompactionDir), "Antigravity jev-context-compaction plugin directory must exist");
      assert.ok(existsSync(agCompactionPluginJson), "Antigravity jev-context-compaction plugin.json must exist");
      assert.ok(existsSync(agRouterDir), "Antigravity jev-router plugin directory must exist");
      assert.ok(existsSync(agRouterPluginJson), "Antigravity jev-router plugin.json must exist");
      assert.ok(existsSync(agRouterSkillMd), "Antigravity jev-router SKILL.md must exist");

      // Verify placeholders in Antigravity router skill are resolved
      const agSkillContent = readFileSync(agRouterSkillMd, "utf8");
      assert.ok(!agSkillContent.includes("${RUNTIME_ROOT}"), "Antigravity router SKILL.md must not contain unresolved placeholder");
    } finally {
      try {
        rmSync(tempHome, { recursive: true, force: true });
      } catch {}
    }
  });
});
