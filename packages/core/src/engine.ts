import type {
  JevAsker,
  JevQuestions,
  RetentionAction,
  RetentionDecision,
  RetentionEngineOptions,
  RetentionPlan,
  ToolEvidence,
} from "./types.ts";
import { computeHash, redactSensitive, safeJsonStringify, truncate } from "./utils.ts";

const DEFAULT_OPTIONS: Required<RetentionEngineOptions> = {
  keepThreshold: 0.5,
  minCompressionGain: 0.15,
  preserveRecentMessages: 6,
  preserveFirstConstraint: true,
  truncateHeadChars: 200,
  timeoutMs: 15_000,
};

export class JevRetentionEngine {
  private asker: JevAsker;
  private options: Required<RetentionEngineOptions>;

  constructor(asker: JevAsker, options: RetentionEngineOptions = {}) {
    this.asker = asker;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Generates a RetentionPlan from an array of ToolEvidence.
   * If Jev fails, times out, or produces malformed answers, this fails open (all items kept).
   */
  async planRetention(evidenceList: ToolEvidence[], contextGoal?: string): Promise<RetentionPlan> {
    const inputHash = computeHash(evidenceList);
    const createdAt = new Date().toISOString();

    if (evidenceList.length === 0) {
      return {
        decisions: [],
        model: "jev-1.13.0",
        provider: "typesafe",
        createdAt,
        inputHash,
      };
    }

    // Identify pinned items
    const total = evidenceList.length;
    const resolvedEvidence = evidenceList.map((item, index) => {
      let pinned = item.pinned;
      // First item constraint pinned
      if (this.options.preserveFirstConstraint && index === 0) {
        pinned = true;
      }
      // Recent items pinned
      if (index >= total - this.options.preserveRecentMessages) {
        pinned = true;
      }
      // Unparseable / opaque / replayable = false pinned
      if (item.replayable === false) {
        pinned = true;
      }
      return { ...item, pinned };
    });

    // Separate pinned and unpinned
    const unpinned = resolvedEvidence.filter((e) => !e.pinned);

    // If everything is pinned, no need to query Jev
    if (unpinned.length === 0) {
      return {
        decisions: resolvedEvidence.map((e) => ({
          id: e.id,
          action: "keep" as RetentionAction,
          keepCall: 1,
          keepResult: 1,
          reason: "pinned",
        })),
        model: "jev-1.13.0",
        provider: "typesafe",
        createdAt,
        inputHash,
      };
    }

    // Build Jev State & Questions
    const state = {
      context:
        "A coding agent context is being compacted. Evaluate each tool execution. User constraints, decisions, non-replayable side-effects, and critical errors must remain verbatim. Common intermediate file reads or redundant queries may have results truncated or dropped.",
      goal: contextGoal || "Retain essential tool evidence while minimizing token waste.",
      evidence: resolvedEvidence.map((e) => ({
        id: e.id,
        tool: e.name,
        input: truncate(safeJsonStringify(redactSensitive(e.input)), 120),
        resultPreview: truncate(safeJsonStringify(redactSensitive(e.output)), 120),
        isError: e.isError,
        pinned: e.pinned,
      })),
    };

    const questions: JevQuestions = {};
    for (const item of unpinned) {
      questions[`call_${item.id}`] = {
        type: "noul",
        instructions: `Tool call ${item.id} (${item.name}) should remain in context: knowing this tool ran with these inputs matters for next actions.`,
      };
      questions[`result_${item.id}`] = {
        type: "noul",
        instructions: `The full output result of tool ${item.id} (${item.name}) must remain verbatim: its exact result is still needed and re-running cannot recover it.`,
      };
    }

    // Call Jev with Fail-Open Guarantee
    let jevResponse;
    try {
      jevResponse = await this.asker.ask(state, questions);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Fail-open: all items kept
      return {
        decisions: resolvedEvidence.map((e) => ({
          id: e.id,
          action: "keep" as RetentionAction,
          keepCall: 1,
          keepResult: 1,
          reason: `fail_open: ${truncate(errMsg, 80)}`,
        })),
        model: "jev-fallback",
        provider: "typesafe",
        createdAt,
        inputHash,
      };
    }

    // Evaluate answers
    const answers = jevResponse.answers || {};
    let totalCharsBefore = 0;
    let potentialSavedChars = 0;

    const preliminaryDecisions = resolvedEvidence.map((item) => {
      const inputStr = safeJsonStringify(item.input);
      const outputStr = safeJsonStringify(item.output);
      const itemChars = inputStr.length + outputStr.length;
      totalCharsBefore += itemChars;

      if (item.pinned) {
        return {
          id: item.id,
          action: "keep" as RetentionAction,
          keepCall: 1.0,
          keepResult: 1.0,
          reason: "pinned",
          itemChars,
          savedChars: 0,
        };
      }

      const callAns = answers[`call_${item.id}`]?.noul;
      const resAns = answers[`result_${item.id}`]?.noul;

      // Validate noul scores
      if (typeof callAns !== "number" || typeof resAns !== "number" || !Number.isFinite(callAns) || !Number.isFinite(resAns)) {
        // Malformed answer -> fail-open for this item
        return {
          id: item.id,
          action: "keep" as RetentionAction,
          keepCall: 1.0,
          keepResult: 1.0,
          reason: "malformed_jev_answer",
          itemChars,
          savedChars: 0,
        };
      }

      let action: RetentionAction = "drop";
      let reason = "call_dropped";
      let saved = 0;

      if (resAns >= this.options.keepThreshold) {
        action = "keep";
        reason = "kept";
        saved = 0;
      } else if (callAns >= this.options.keepThreshold) {
        action = "truncate_result";
        reason = "result_truncated";
        saved = Math.max(0, outputStr.length - this.options.truncateHeadChars);
      } else {
        action = "drop";
        reason = "call_dropped";
        saved = itemChars;
      }

      potentialSavedChars += saved;
      return {
        id: item.id,
        action,
        keepCall: callAns,
        keepResult: resAns,
        reason,
        itemChars,
        savedChars: saved,
      };
    });

    // Check minimum compression gain
    const compressionRatio = totalCharsBefore > 0 ? potentialSavedChars / totalCharsBefore : 0;
    const meetsMinGain = compressionRatio >= this.options.minCompressionGain;

    const finalDecisions: RetentionDecision[] = preliminaryDecisions.map((d) => {
      // If minimum compression gain not met and item was marked to truncate/drop,
      // keep it to prevent risky context loss with negligible gain.
      if (!meetsMinGain && d.action !== "keep") {
        return {
          id: d.id,
          action: "keep",
          keepCall: d.keepCall,
          keepResult: d.keepResult,
          reason: "min_compression_gain_unmet",
        };
      }
      return {
        id: d.id,
        action: d.action,
        keepCall: d.keepCall,
        keepResult: d.keepResult,
        reason: d.reason,
      };
    });

    return {
      decisions: finalDecisions,
      model: jevResponse.model || "jev-1.13.0",
      provider: "typesafe",
      createdAt,
      inputHash,
    };
  }
}
