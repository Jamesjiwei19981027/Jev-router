#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const apiUrl = (process.env.JEV_API_URL || process.env.JEV_BASE_URL || "").trim();
if (!apiUrl) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: "missing_jev_api_url" })}\n`);
  process.exit(1);
}

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(runtimeRoot, "vendor", "JevRouter", "bin", "jevrouter.mjs");
const keyFile = process.env.TYPESAFE_API_KEY_FILE || join(runtimeRoot, "secrets", "typesafe_api_key");
if (existsSync(keyFile)) {
  process.env.TYPESAFE_API_KEY = readFileSync(keyFile, "utf8").trim();
}

process.env.JEV_API_URL = apiUrl;
process.env.JEV_MODEL ||= "jev-1.13.0";

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: runtimeRoot,
  env: { ...process.env, JEV_ROUTER_PROVIDER: "typesafe" },
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`JevRouter launcher failed: ${result.error.message}\n`);
}
process.exit(result.status ?? 1);
