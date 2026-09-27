import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const home = process.env.MOCK_HOME || process.env.USERPROFILE || homedir();
const jevAgentDir = join(home, ".jev-agent");
const targetBinDir = join(jevAgentDir, "bin");
const targetVendorDir = join(jevAgentDir, "vendor");

console.log(`=== Setting up Jev Agent Shared Runtime in ${jevAgentDir} ===`);

// 1. Install runtime to ~/.jev-agent/bin
const sourceBinDir = join(repoRoot, "packages", "runtime", "bin");
if (existsSync(sourceBinDir)) {
  mkdirSync(targetBinDir, { recursive: true });
  cpSync(sourceBinDir, targetBinDir, { recursive: true, force: true });
  console.log(`Installed shared runtime binaries to: ${targetBinDir}`);
} else {
  console.error(`Runtime source directory not found: ${sourceBinDir}`);
  process.exit(1);
}

// 2. Setup pinned vendors in ~/.jev-agent/vendor
const UPSTREAMS = [
  {
    name: "JevRouter",
    url: "https://github.com/BillionsBobby/JevRouter.git",
    commit: "f944acb6530621bced023352e2358a63218bf4d9",
    dirName: "JevRouter",
    aliases: ["JevRouter"],
  },
  {
    name: "save-token-jev",
    url: "https://github.com/IAmUnbounded/save-token-jev-clean.git",
    commit: "a7007354a8d3747f06ff82130561edb2822a17df",
    dirName: "save-token-jev-clean",
    aliases: ["save-token-jev-clean", "save-token-jev"],
  },
];

mkdirSync(targetVendorDir, { recursive: true });

function getRepoCommit(dir) {
  if (!existsSync(join(dir, ".git"))) return null;
  try {
    return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

for (const upstream of UPSTREAMS) {
  let matchedDir = null;
  for (const alias of upstream.aliases) {
    const candidateDir = join(targetVendorDir, alias);
    const commit = getRepoCommit(candidateDir);
    if (commit === upstream.commit) {
      matchedDir = candidateDir;
      break;
    }
  }

  if (matchedDir) {
    console.log(`Upstream ${upstream.name} is already present and matches commit ${upstream.commit.slice(0, 7)} (in ${matchedDir}), skipping.`);
    continue;
  }

  const targetDir = join(targetVendorDir, upstream.dirName);
  console.log(`Cloning ${upstream.name} into ${targetDir}...`);
  execSync(`git clone ${upstream.url} "${targetDir}"`, { stdio: "inherit" });
  console.log(`Checking out commit ${upstream.commit}...`);
  execSync(`git checkout ${upstream.commit}`, { cwd: targetDir, stdio: "inherit" });

  console.log(`Building ${upstream.name}...`);
  const isWindows = process.platform === "win32";
  const npmCmd = isWindows ? "npm.cmd" : "npm";
  const installResult = spawnSync(npmCmd, ["install"], { cwd: targetDir, stdio: "inherit" });
  if (installResult.status !== 0) {
    console.error(`Failed to npm install in ${targetDir}`);
    process.exit(1);
  }
  const buildResult = spawnSync(npmCmd, ["run", "build"], { cwd: targetDir, stdio: "inherit" });
  if (buildResult.status !== 0) {
    console.error(`Failed to npm run build in ${targetDir}`);
    process.exit(1);
  }
  console.log(`Built ${upstream.name} successfully.`);
}

console.log("=== Jev Agent Shared Runtime Setup Complete ===");
