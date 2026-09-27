import { createHash } from "node:crypto";

const SENSITIVE_KEY_REGEX = /^(?:api[_-]?key|access[_-]?token|token|password|secret|authorization|auth)$/i;
const SENSITIVE_PATTERN_REGEX = /("(?:api[_-]?key|access[_-]?token|token|password|secret|authorization)"\s*:\s*)"[^"]*"/gi;
// Consumes an optional auth scheme so "Authorization: Bearer <tok>" never leaves <tok> behind.
const SENSITIVE_KV_REGEX = /((?:api[_-]?key|access[_-]?token|token|password|secret|authorization)\s*(?:[=:]|\s)\s*)(?:(?:Bearer|Basic|Digest|Token)\s+)?[^\s,}"']+/gi;
const BEARER_REGEX = /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_PREFIX_REGEX = /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_-]{8,})\b/g;

export function redactSensitive(value: unknown, seen = new WeakSet()): unknown {
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
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
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

export function safeJsonStringify(value: unknown, limit?: number): string {
  try {
    const redacted = redactSensitive(value);
    const str = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
    if (!str) return "";
    if (typeof limit === "number" && limit > 0 && str.length > limit) {
      return `${str.slice(0, limit)}...`;
    }
    return str;
  } catch {
    return "[Unserializable]";
  }
}

export function computeHash(content: unknown): string {
  const normalized = typeof content === "string" ? content : JSON.stringify(content);
  return createHash("sha256").update(normalized || "").digest("hex");
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const pieces = text.match(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g) ?? [];
  let tokens = 0;
  for (const piece of pieces) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) {
      tokens += piece.length / 2;
    } else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else {
      tokens += 0.9;
    }
  }
  return Math.ceil(tokens);
}

export function truncate(text: string, limit: number): string {
  if (!text || text.length <= limit) return text || "";
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
}
