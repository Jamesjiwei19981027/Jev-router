import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { JevAsker, JevQuestions, JevResponse } from "./types.ts";

export interface WindowsJevTransportOptions {
  apiKey?: string;
  keyFile?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export class WindowsJevTransport implements JevAsker {
  private keyFile: string;
  private explicitKey?: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;

  constructor(options: WindowsJevTransportOptions = {}) {
    const home = process.env.USERPROFILE || homedir();
    this.keyFile =
      options.keyFile ||
      process.env.TYPESAFE_API_KEY_FILE ||
      join(home, ".jev-agent", "secrets", "typesafe_api_key");
    this.explicitKey = options.apiKey;
    this.baseUrl =
      options.baseUrl ||
      process.env.JEV_API_URL ||
      process.env.JEV_BASE_URL ||
      "";
    this.model = options.model || process.env.JEV_MODEL || "jev-1.13.0";
    this.timeoutMs = options.timeoutMs || 25_000;
  }

  private resolveKey(): string {
    if (this.explicitKey) return this.explicitKey;

    // If a key file exists on disk, it is authoritative: never fall back to env var if empty or unreadable
    if (existsSync(this.keyFile)) {
      try {
        return readFileSync(this.keyFile, "utf8").trim();
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

  async ask(state: unknown, questions: JevQuestions): Promise<JevResponse> {
    if (!this.baseUrl) {
      throw new Error("Jev API URL not configured");
    }
    const key = this.resolveKey();
    if (!key) {
      throw new Error("Jev authentication key not configured");
    }

    const payload = {
      model: this.model,
      state,
      questions,
    };

    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Jev service returned HTTP ${response.status}: ${errText.slice(0, 100)}`);
    }

    const data = (await response.json()) as JevResponse;
    if (!data || typeof data !== "object" || !data.answers || typeof data.answers !== "object") {
      throw new Error("Jev returned malformed response: missing answers dictionary");
    }

    return data;
  }
}
