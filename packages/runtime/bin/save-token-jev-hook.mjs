#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const apiUrl = (process.env.JEV_API_URL || process.env.JEV_BASE_URL || "").trim();
if (!apiUrl) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "missing_jev_api_url" })}\n`);
  process.exit(1);
}

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const keyFile = process.env.TYPESAFE_API_KEY_FILE || join(runtimeRoot, "secrets", "typesafe_api_key");
const env = { ...process.env };
if (existsSync(keyFile)) {
  env.TYPESAFE_API_KEY = readFileSync(keyFile, "utf8").trim();
}

env.JEV_BASE_URL = apiUrl;
env.JEV_API_URL = apiUrl;
env.JEV_MODEL ||= "jev-1.13.0";

const cliCandidates = [
  join(runtimeRoot, "vendor", "save-token-jev-clean", "dist", "cli.js"),
  join(runtimeRoot, "vendor", "save-token-jev", "dist", "cli.js"),
];
const cli = cliCandidates.find((c) => existsSync(c)) || cliCandidates[0];

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: runtimeRoot,
  env,
  stdio: "inherit",
});
if (result.error) process.stderr.write(`save-token-jev launcher failed: ${result.error.message}\n`);
process.exit(result.status ?? 1);
