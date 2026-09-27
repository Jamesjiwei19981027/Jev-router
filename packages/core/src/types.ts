export type ToolEvidence = {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  isError: boolean;
  replayable: boolean;
  pinned: boolean;
  sourceRef?: string;
  createdAt?: string;
};

export type RetentionAction = "keep" | "truncate_result" | "drop";

export type RetentionDecision = {
  id: string;
  action: RetentionAction;
  keepCall: number;
  keepResult: number;
  reason: string;
};

export type RetentionPlan = {
  decisions: RetentionDecision[];
  model: string;
  provider: string;
  createdAt: string;
  inputHash: string;
};

export interface HostAdapter<Snapshot, Result> {
  capture(input: unknown): Promise<Snapshot>;
  toEvidence(snapshot: Snapshot): ToolEvidence[];
  apply(snapshot: Snapshot, plan: RetentionPlan): Promise<Result>;
}

export interface NativeCompactionAdapter {
  canReplaceNativeCompaction(): boolean;
  captureNativeCompactionInput(input: unknown): Promise<unknown>;
  replaceNativeCompaction(input: unknown, plan: RetentionPlan): Promise<unknown>;
  restoreAfterCompaction(result: unknown, plan: RetentionPlan): Promise<unknown>;
}

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type JevQuestions = Record<string, NoulQuestion>;

export interface JevAnswer {
  type?: "noul";
  noul: number;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

export interface JevAsker {
  ask(state: unknown, questions: JevQuestions): Promise<JevResponse>;
}

export interface RetentionEngineOptions {
  keepThreshold?: number; // default: 0.5
  minCompressionGain?: number; // default: 0.15
  preserveRecentMessages?: number; // default: 6
  preserveFirstConstraint?: boolean; // default: true
  truncateHeadChars?: number; // default: 200
  timeoutMs?: number; // default: 15000
}
