import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const home = process.env.MOCK_HOME || process.env.USERPROFILE || homedir();

// Parse arguments
const args = process.argv.slice(2);
let targetHost = "all";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--host" && args[i + 1]) {
    targetHost = args[i + 1];
    i++;
  } else if (args[i].startsWith("--host=")) {
    targetHost = args[i].slice("--host=".length);
  }
}

const VALID_HOSTS = ["claude-code", "codex", "pi", "antigravity", "all"];
if (!VALID_HOSTS.includes(targetHost)) {
  console.error(`Invalid host: ${targetHost}. Must be one of: ${VALID_HOSTS.join(", ")}`);
  process.exit(1);
}

// Backup setup: ~/.jev-agent/backups/<timestamp>/
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = join(home, ".jev-agent", "backups", timestamp);

function backupFile(filePath) {
  if (!existsSync(filePath)) return;
  const rel = relative(home, filePath);
  const backupDest = rel.startsWith("..")
    ? join(backupRoot, "external", filePath.replace(/[:\\/]/g, "_"))
    : join(backupRoot, rel);
  mkdirSync(dirname(backupDest), { recursive: true });
  copyFileSync(filePath, backupDest);
  console.log(`[backup] Saved ${filePath} -> ${backupDest}`);
}

function backupDir(dirPath) {
  if (!existsSync(dirPath)) return;
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      backupDir(full);
    } else if (entry.isFile()) {
      backupFile(full);
    }
  }
}

function copyWithPlaceholderReplacement(srcDir, destDir, replacements) {
  mkdirSync(destDir, { recursive: true });
  const entries = readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyWithPlaceholderReplacement(srcPath, destPath, replacements);
    } else if (entry.isFile()) {
      backupFile(destPath);
      let content = readFileSync(srcPath, "utf8");
      for (const [placeholder, value] of Object.entries(replacements)) {
        content = content.replaceAll(placeholder, value);
      }
      writeFileSync(destPath, content, "utf8");
    }
  }
}

function updateMarkdownRule(filePath, ruleTemplatePath, replacements) {
  backupFile(filePath);
  let rawRule = readFileSync(ruleTemplatePath, "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    rawRule = rawRule.replaceAll(placeholder, value);
  }
  rawRule = rawRule.trim();

  // Standardized rule block format with opening and closing tags
  const standardizedBlock = rawRule.includes("<!-- /jev-agent:global-routing-v1 -->")
    ? rawRule
    : `${rawRule}\n<!-- /jev-agent:global-routing-v1 -->`;

  if (!existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${standardizedBlock}\n`, "utf8");
    console.log(`Created ${filePath} with global routing rule.`);
    return;
  }

  const existingContent = readFileSync(filePath, "utf8");

  // Regex to match existing rule block (with or without closing tag)
  const blockRegex = /<!-- jev-agent:global-routing-v1 -->[\s\S]*?(?:<!-- \/jev-agent:global-routing-v1 -->|$)/;

  let newContent;
  if (blockRegex.test(existingContent)) {
    newContent = existingContent.replace(blockRegex, standardizedBlock);
  } else {
    // Append at the end preserving exact preceding content
    const prefix = existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
    newContent = `${prefix}\n${standardizedBlock}\n`;
  }

  writeFileSync(filePath, newContent, "utf8");
  console.log(`Updated routing rule in ${filePath}.`);
}

const runtimeRoot = join(home, ".jev-agent");
const standardReplacements = {
  "${RUNTIME_ROOT}": runtimeRoot,
  "${HOME}": home,
  "${USERPROFILE}": home,
};

// ---------------------------------------------------------------------------
// 1. Host: Pi
// ---------------------------------------------------------------------------
function deployPi() {
  console.log("\n=== Deploying Pi extensions ===");
  const piExtDir = join(home, ".pi", "agent", "extensions");
  mkdirSync(piExtDir, { recursive: true });

  // 1.1 Bundled compaction extension
  const sourceCompaction = join(repoRoot, "packages", "pi-adapter", "src", "extension.ts");
  const targetCompaction = join(piExtDir, "jev-context-compaction.ts");
  backupFile(targetCompaction);

  const realHome = process.env.USERPROFILE || homedir();
  const esbuildCandidates = [
    join(runtimeRoot, "vendor", "JevRouter", "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
    join(realHome, ".jev-agent", "vendor", "JevRouter", "node_modules", "@esbuild", "win32-x64", "esbuild.exe"),
    join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild"),
  ];
  const esbuildPath = esbuildCandidates.find((p) => existsSync(p));

  console.log("Bundling Pi compaction extension...");
  const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const cmd = esbuildPath || npxCmd;
  const buildArgs = esbuildPath
    ? [
        sourceCompaction,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--external:node:*",
        `--outfile=${targetCompaction}`,
      ]
    : [
        "esbuild",
        sourceCompaction,
        "--bundle",
        "--platform=node",
        "--format=esm",
        "--target=node20",
        "--external:node:*",
        `--outfile=${targetCompaction}`,
      ];

  const buildResult = spawnSync(cmd, buildArgs, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (buildResult.status !== 0) {
    console.error("Bundle failed:", buildResult.stderr || buildResult.stdout);
    process.exit(1);
  }
  console.log(`Pi compaction extension bundled to: ${targetCompaction}`);

  // 1.2 Router extension
  const sourceRouter = join(repoRoot, "packages", "pi-router", "src", "extension.ts");
  const targetRouter = join(piExtDir, "jev-router.ts");
  backupFile(targetRouter);
  copyFileSync(sourceRouter, targetRouter);
  console.log(`Pi router extension deployed to: ${targetRouter}`);
}

// ---------------------------------------------------------------------------
// 2. Host: Antigravity
// ---------------------------------------------------------------------------
function deployAntigravity() {
  console.log("\n=== Deploying Antigravity plugins ===");
  const pluginsDir = join(home, ".gemini", "config", "plugins");
  mkdirSync(pluginsDir, { recursive: true });

  // 2.1 jev-context-compaction plugin
  const sourceCompactionPlugin = join(repoRoot, "packages", "antigravity-plugin");
  const targetCompactionPlugin = join(pluginsDir, "jev-context-compaction");
  backupDir(targetCompactionPlugin);
  copyWithPlaceholderReplacement(sourceCompactionPlugin, targetCompactionPlugin, standardReplacements);
  console.log(`Antigravity context compaction plugin deployed to: ${targetCompactionPlugin}`);

  // 2.2 jev-router plugin
  const sourceRouterPlugin = join(repoRoot, "packages", "antigravity-router");
  const targetRouterPlugin = join(pluginsDir, "jev-router");
  backupDir(targetRouterPlugin);
  copyWithPlaceholderReplacement(sourceRouterPlugin, targetRouterPlugin, standardReplacements);
  console.log(`Antigravity router plugin deployed to: ${targetRouterPlugin}`);

  // Clean up legacy plugins.json and old ~/.jev-agent/antigravity-plugins
  const pluginsJsonPath = join(home, ".gemini", "config", "plugins.json");
  if (existsSync(pluginsJsonPath)) {
    try {
      const content = readFileSync(pluginsJsonPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.entries)) {
        const remaining = parsed.entries.filter((entry) => {
          const p = String(entry?.path || "").toLowerCase();
          return !p.includes("antigravity-plugins") && !p.includes("jev-context-compaction") && !p.includes("jev-router");
        });
        if (remaining.length === 0) {
          unlinkSync(pluginsJsonPath);
          console.log(`Cleaned up ${pluginsJsonPath} (entries empty, file removed).`);
        } else {
          parsed.entries = remaining;
          writeFileSync(pluginsJsonPath, JSON.stringify(parsed, null, 2), "utf8");
        }
      }
    } catch (err) {
      console.warn(`Warning: failed to process ${pluginsJsonPath}:`, err);
    }
  }

  const legacyPluginDir = join(home, ".jev-agent", "antigravity-plugins");
  if (existsSync(legacyPluginDir)) {
    try {
      rmSync(legacyPluginDir, { recursive: true, force: true });
      console.log(`Removed legacy plugin directory: ${legacyPluginDir}`);
    } catch (err) {
      console.warn(`Warning: failed to remove legacy plugin directory ${legacyPluginDir}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Host: Claude Code
// ---------------------------------------------------------------------------
function deployClaudeCode() {
  console.log("\n=== Deploying Claude Code integration ===");
  const skillDestDir = join(home, ".claude", "skills", "jevrouter");
  const skillSrcDir = join(repoRoot, "packages", "claude-code", "skills", "jevrouter");
  backupDir(skillDestDir);
  copyWithPlaceholderReplacement(skillSrcDir, skillDestDir, standardReplacements);
  console.log(`Claude Code skill deployed to: ${skillDestDir}`);

  const claudeMdPath = join(home, ".claude", "CLAUDE.md");
  const ruleTemplate = join(repoRoot, "packages", "claude-code", "global-routing-rule.md");
  updateMarkdownRule(claudeMdPath, ruleTemplate, standardReplacements);
}

// ---------------------------------------------------------------------------
// 4. Host: Codex
// ---------------------------------------------------------------------------
function deployCodex() {
  console.log("\n=== Deploying Codex integration ===");
  const skillDestDir = join(home, ".codex", "skills", "jevrouter");
  const skillSrcDir = join(repoRoot, "packages", "codex", "skills", "jevrouter");
  backupDir(skillDestDir);
  copyWithPlaceholderReplacement(skillSrcDir, skillDestDir, standardReplacements);
  console.log(`Codex skill deployed to: ${skillDestDir}`);

  // hooks.json template
  const hooksDestPath = join(home, ".codex", "hooks.json");
  const hooksTemplatePath = join(repoRoot, "packages", "codex", "hooks.json");
  backupFile(hooksDestPath);
  mkdirSync(dirname(hooksDestPath), { recursive: true });
  let hooksContent = readFileSync(hooksTemplatePath, "utf8");
  // For JSON files, backslashes must be properly escaped
  const escapedRuntimeRoot = runtimeRoot.replace(/\\/g, "\\\\");
  hooksContent = hooksContent.replaceAll("${RUNTIME_ROOT}", escapedRuntimeRoot);
  writeFileSync(hooksDestPath, hooksContent, "utf8");
  console.log(`Codex hooks deployed to: ${hooksDestPath}`);

  // AGENTS.md rule
  const agentsMdPath = join(home, ".codex", "AGENTS.md");
  const ruleTemplate = join(repoRoot, "packages", "codex", "global-routing-rule.md");
  updateMarkdownRule(agentsMdPath, ruleTemplate, standardReplacements);
}

// Run selected deployment
if (targetHost === "pi" || targetHost === "all") deployPi();
if (targetHost === "antigravity" || targetHost === "all") deployAntigravity();
if (targetHost === "claude-code" || targetHost === "all") deployClaudeCode();
if (targetHost === "codex" || targetHost === "all") deployCodex();

console.log("\n=== Deployment finished successfully ===");
