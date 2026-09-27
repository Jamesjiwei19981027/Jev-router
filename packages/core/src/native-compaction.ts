import type { NativeCompactionAdapter, RetentionPlan } from "./types.ts";

/**
 * Phase 1 placeholder for native compaction replacement.
 * Strictly returns canReplaceNativeCompaction() = false.
 * Will only be activated if and when the host runtime officially provides
 * verifiable native compaction replacement hook points.
 */
export class ReservedNativeCompactionAdapter implements NativeCompactionAdapter {
  canReplaceNativeCompaction(): boolean {
    return false;
  }

  async captureNativeCompactionInput(_input: unknown): Promise<unknown> {
    throw new Error(
      "Native compaction replacement is not supported in Phase 1. Use Jev evidence recall instead."
    );
  }

  async replaceNativeCompaction(_input: unknown, _plan: RetentionPlan): Promise<unknown> {
    throw new Error(
      "Native compaction replacement is not supported in Phase 1. Use Jev evidence recall instead."
    );
  }

  async restoreAfterCompaction(_result: unknown, _plan: RetentionPlan): Promise<unknown> {
    throw new Error(
      "Native compaction replacement is not supported in Phase 1. Use Jev evidence recall instead."
    );
  }
}
