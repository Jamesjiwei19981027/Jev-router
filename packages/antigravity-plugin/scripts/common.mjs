import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const FALLBACK_STDOUT_UNAVAILABLE = "[Action executed; stdout artifact unavailable]";
export const STEP_OUTPUT_READ_BYTES = 64 * 1024;
export const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export function readBounded(path, maxBytes, fromEnd) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    return { text: buffer.toString("utf8", 0, bytesRead), clipped: size > length };
  } finally {
    closeSync(fd);
  }
}

const SENSITIVE_KEY_REGEX = /^(?:api[_-]?key|access[_-]?token|token|password|secret|authorization|auth)$/i;
const SENSITIVE_PATTERN_REGEX = /("(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)"\s*:\s*)"[^"]*"/gi;
// Consumes an optional auth scheme so "Authorization: Bearer <tok>" never leaves <tok> behind.
const SENSITIVE_KV_REGEX = /((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*(?:[=:]|\s)\s*)(?:(?:Bearer|Basic|Digest|Token)\s+)?[^\s,}"']+/gi;
const BEARER_REGEX = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PREFIX_REGEX = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,})\b/g;

export function truncate(text, maxLength = 1000) {
  if (text === null || text === undefined) return "";
  const str = typeof text === "string" ? text : JSON.stringify(text);
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength) + " ...[truncated]";
}

export function getDataDir() {
  if (process.env.JEV_DATA_DIR) {
    return resolve(process.env.JEV_DATA_DIR);
  }
  const home = process.env.USERPROFILE || homedir();
  return join(home, ".jev-agent", "data", "antigravity");
}

export function resolveKey() {
  const home = process.env.USERPROFILE || homedir();
  const keyFile = process.env.TYPESAFE_API_KEY_FILE || join(home, ".jev-agent", "secrets", "typesafe_api_key");
  
  // If a key file exists on disk, it is strictly authoritative: never fall back to env var if empty or unreadable
  if (existsSync(keyFile)) {
    try {
      return readFileSync(keyFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  // If TYPESAFE_API_KEY_FILE was explicitly specified, do not fall back to TYPESAFE_API_KEY
  if (process.env.TYPESAFE_API_KEY_FILE) {
    return "";
  }

  // Only fall back to env var when no key file is configured and default secret file does not exist
  if (process.env.TYPESAFE_API_KEY) {
    return process.env.TYPESAFE_API_KEY;
  }
  return "";
}

export function redactSensitive(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    let text = value.replace(SENSITIVE_PATTERN_REGEX, '$1"[REDACTED]"');
    text = text.replace(SENSITIVE_KV_REGEX, '$1[REDACTED]');
    text = text.replace(BEARER_REGEX, '$1[REDACTED]');
    text = text.replace(TOKEN_PREFIX_REGEX, '[REDACTED]');
    return text;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => redactSensitive(item, seen));
    }
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactSensitive(val, seen);
      }
    }
    return result;
  }
  return value;
}

export function sha256(data) {
  const normalized = typeof data === "string" ? data : JSON.stringify(data || "");
  return createHash("sha256").update(normalized).digest("hex");
}

export function atomicWrite(targetPath, content) {
  const dir = dirname(targetPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmpPath, content, "utf8");
    // Windows atomic rename retry for potential lock
    let retries = 5;
    while (retries > 0) {
      try {
        renameSync(tmpPath, targetPath);
        break;
      } catch (err) {
        retries--;
        if (retries === 0) {
          // Fallback: direct overwrite
          writeFileSync(targetPath, content, "utf8");
          try { unlinkSync(tmpPath); } catch {}
          break;
        }
        // Small synchronous backoff
        const start = Date.now();
        while (Date.now() - start < 15) {}
      }
    }
  } catch (err) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

export function readJson(filePath, fallback = null) {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function askJev(state, questions, timeoutMs = 12000) {
  const url = process.env.JEV_API_URL || process.env.JEV_BASE_URL;
  if (!url) throw new Error("JEV_API_URL not configured");

  const key = resolveKey();
  if (!key) throw new Error("Jev authentication key not configured");

  const model = process.env.JEV_MODEL || "jev-1.13.0";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ model, state, questions }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Jev returned status ${response.status}: ${text.slice(0, 100)}`);
  }

  const json = await response.json();
  if (!json || typeof json !== "object" || !json.answers) {
    throw new Error("Jev response missing answers");
  }
  return json;
}

export function backfillPendingEvidence(evidenceList, transcriptPath) {
  if (!Array.isArray(evidenceList) || evidenceList.length === 0) {
    return false;
  }
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return false;
  }

  const hasPending = evidenceList.some(
    (item) => item && item.output === FALLBACK_STDOUT_UNAVAILABLE
  );
  if (!hasPending) {
    return false;
  }

  let transcriptLines = [];
  try {
    const tail = readBounded(transcriptPath, TRANSCRIPT_TAIL_BYTES, true);
    transcriptLines = tail.text.trim().split("\n");
    if (tail.clipped) transcriptLines.shift();
  } catch {
    return false;
  }

  if (transcriptLines.length === 0) {
    return false;
  }

  let modified = false;
  for (const item of evidenceList) {
    if (item && item.output === FALLBACK_STDOUT_UNAVAILABLE) {
      const stepIdx = Number(String(item.id || "").replace("step_", ""));
      if (!Number.isNaN(stepIdx)) {
        for (let i = transcriptLines.length - 1; i >= 0; i--) {
          const line = transcriptLines[i]?.trim();
          if (!line) continue;
          try {
            const p = JSON.parse(line);
            if (
              p.type === "GENERIC" &&
              p.step_index === stepIdx &&
              p.status === "DONE" &&
              p.content
            ) {
              item.output = truncate(redactSensitive(p.content), 1000);
              modified = true;
              break;
            }
          } catch {}
        }
      }
    }
  }

  return modified;
}

