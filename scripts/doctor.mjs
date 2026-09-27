import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const home = process.env.MOCK_HOME || process.env.USERPROFILE || homedir();
const jevAgentBin = join(home, ".jev-agent", "bin", "jev-agent.mjs");

if (!existsSync(jevAgentBin)) {
  console.error(`jev-agent binary not found at ${jevAgentBin}. Please run 'npm run setup' first.`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [jevAgentBin, "doctor"], {
  encoding: "utf8",
  env: process.env,
});

if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exit(result.status ?? 0);
