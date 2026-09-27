import type { RetentionDecision, RetentionPlan } from "../../core/src/index.ts";

export interface PiToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PiTextContent {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: Array<PiTextContent | { type: string; [key: string]: unknown }> | string;
  isError?: boolean;
  timestamp?: number;
  [key: string]: unknown;
}

export interface PiAssistantMessage {
  role: "assistant";
  content: Array<PiToolCallContent | PiTextContent | { type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface PiGenericMessage {
  role: string;
  content?: unknown;
  [key: string]: unknown;
}

export type PiMessage = PiAssistantMessage | PiToolResultMessage | PiGenericMessage;

export function estimateTokens(contentOrMessage: unknown): number {
  if (contentOrMessage === null || contentOrMessage === undefined) return 0;
  if (typeof contentOrMessage === "string") {
    return Math.ceil(contentOrMessage.length / 4);
  }
  const str = JSON.stringify(contentOrMessage);
  return Math.ceil(str.length / 4);
}

export interface PiSnapshot {
  messages: PiMessage[];
  turnPrefixMessages?: PiMessage[];
  isSplitTurn?: boolean;
  previousSummary?: string;
  totalChars: number;
  tokensBefore: number;
  firstKeptEntryId?: string;
  fileOps?: any;
  settings?: any;
}

export interface PiCompactionStats {
  messagesBefore: number;
  messagesAfter: number;
  toolCallsBefore: number;
  toolCallsKept: number;
  toolCallsTruncated: number;
  toolCallsDropped: number;
  charsBefore: number;
  charsAfter: number;
  savedChars: number;
  tokensBefore: number;
  tokensAfter: number;
  savedTokens: number;
  model: string;
  provider: string;
  timestamp: string;
  fallback?: string;
}

export interface PiApplyResult {
  messages: PiMessage[];
  turnPrefixMessages: PiMessage[];
  summary: string;
  plan: RetentionPlan;
  stats: PiCompactionStats;
}

