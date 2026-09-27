#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_TIMEOUT_MS = 30_000;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function fail(message, details = {}) {
  printJson({ ok: false, error: message, ...details });
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      args._ = [...(args._ ?? []), token];
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function config() {
  const configuredUrl = (process.env.JEV_API_URL || process.env.JEV_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!configuredUrl) {
    fail("missing_jev_api_url");
    process.exit(1);
  }
  const baseUrl = configuredUrl.endsWith("/systemone")
    ? configuredUrl.slice(0, -"/systemone".length)
    : configuredUrl;
  const systemOneUrl = configuredUrl.endsWith("/systemone") ? configuredUrl : `${configuredUrl}/systemone`;
  const model = process.env.JEV_MODEL || DEFAULT_MODEL;
  let apiKey;
  if (process.env.TYPESAFE_API_KEY_FILE) {
    try {
      apiKey = readFileSync(process.env.TYPESAFE_API_KEY_FILE, "utf8").trim();
    } catch {
      apiKey = undefined;
    }
  }
  apiKey ||= process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
  const timeoutMs = Number.parseInt(process.env.JEV_TIMEOUT_MS || `${DEFAULT_TIMEOUT_MS}`, 10);
  return {
    baseUrl,
    model,
    apiKey,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    systemOneUrl,
    modelsUrl: baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`,
  };
}

function requireKey(settings) {
  if (!settings.apiKey) {
    throw new Error("missing_credentials");
  }
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(`http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function doctor(settings) {
  requireKey(settings);
  const body = await fetchJson(
    settings.modelsUrl,
    { headers: { Authorization: `Bearer ${settings.apiKey}` } },
    settings.timeoutMs,
  );
  const servedModels = Array.isArray(body?.data)
    ? body.data.map((model) => model?.id).filter((id) => typeof id === "string")
    : [];
  printJson({
    ok: servedModels.length > 0,
    endpoint: settings.baseUrl,
    requestedModel: settings.model,
    servedModels,
  });
  if (servedModels.length === 0) process.exitCode = 1;
}

async function readTextFile(path) {
  return readFile(path, "utf8");
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

async function readJsonInput(args) {
  const raw = args.input && args.input !== "-" ? await readTextFile(args.input) : await readStdin();
  if (!raw.trim()) throw new Error("empty_input");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

function validateRequest(request) {
  if (!request || typeof request !== "object") throw new Error("request_must_be_object");
  if (request.state === undefined || request.state === null) throw new Error("missing_state");
  if (!request.questions || typeof request.questions !== "object") throw new Error("missing_questions");
}

async function ask(settings, request) {
  validateRequest(request);
  requireKey(settings);
  const payload = { ...request, model: request.model || settings.model };
  return fetchJson(
    settings.systemOneUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    settings.timeoutMs,
  );
}

function parseCandidates(value) {
  let candidates;
  try {
    candidates = JSON.parse(value);
  } catch {
    throw new Error("invalid_candidates_json");
  }
  if (!Array.isArray(candidates) || candidates.length < 2) throw new Error("at_least_two_candidates_required");
  const criteria = {};
  for (const candidate of candidates) {
    const name = typeof candidate === "string" ? candidate : candidate?.name;
    if (!name || typeof name !== "string") throw new Error("candidate_name_required");
    if (Object.hasOwn(criteria, name)) throw new Error("duplicate_candidate_name");
    criteria[name] = typeof candidate === "string" ? candidate : candidate.description || name;
  }
  return criteria;
}

async function route(settings, args) {
  if (!args.request || !args.candidates) throw new Error("request_and_candidates_required");
  const criteria = parseCandidates(args.candidates);
  const response = await ask(settings, {
    state: args.request,
    questions: {
      route: {
        type: "choice",
        instructions: "Which capability should handle this request? Select one candidate and do not execute it.",
        criteria,
      },
    },
  });
  printJson(response);
}

function usage() {
  printJson({
    commands: {
      doctor: "jev-agent doctor",
      route: "jev-agent route --request TEXT --candidates JSON_ARRAY",
      ask: "echo JSON | jev-agent ask [--input FILE]",
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._?.[0];
  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }
  const settings = config();
  if (command === "doctor") {
    await doctor(settings);
    return;
  }
  if (command === "route") {
    await route(settings, args);
    return;
  }
  if (command === "ask") {
    const request = await readJsonInput(args);
    printJson(await ask(settings, request));
    return;
  }
  throw new Error("unknown_command");
}

try {
  await main();
} catch (error) {
  const details = {};
  if (Number.isInteger(error?.status)) details.status = error.status;
  if (error?.name === "AbortError") details.status = "timeout";
  fail(error instanceof Error ? error.message : "runtime_error", details);
}
