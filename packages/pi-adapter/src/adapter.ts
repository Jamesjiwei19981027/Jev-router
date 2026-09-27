import type {
  HostAdapter,
  RetentionPlan,
  ToolEvidence,
} from "../../core/src/index.ts";
import { safeJsonStringify } from "../../core/src/index.ts";
import type {
  PiApplyResult,
  PiAssistantMessage,
  PiCompactionStats,
  PiMessage,
  PiSnapshot,
  PiToolCallContent,
  PiToolResultMessage,
} from "./types.ts";

function extractMessagesFromSessionEntries(entries: any[]): PiMessage[] {
  const msgs: PiMessage[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "message" && entry.message) {
      msgs.push(entry.message);
    } else if (entry.type === "custom_message" && entry.message) {
      msgs.push(entry.message);
    } else if ("role" in entry) {
      msgs.push(entry);
    }
  }
  return msgs;
}

export class PiHostAdapter implements HostAdapter<PiSnapshot, PiApplyResult> {
  private recentMessagesPinnedCount: number;

  constructor(recentMessagesPinnedCount = 6) {
    this.recentMessagesPinnedCount = recentMessagesPinnedCount;
  }

  async capture(input: unknown): Promise<PiSnapshot> {
    let messages: PiMessage[] = [];
    let turnPrefixMessages: PiMessage[] = [];
    let isSplitTurn = false;
    let previousSummary: string | undefined;
    let firstKeptEntryId: string | undefined;
    let tokensBefore: number | undefined;
    let fileOps: any;
    let settings: any;

    if (input && typeof input === "object") {
      const anyObj = input as any;

      // Handle real Pi SessionBeforeCompactEvent
      if (anyObj.type === "session_before_compact" || anyObj.preparation) {
        const prep = anyObj.preparation || {};
        firstKeptEntryId = prep.firstKeptEntryId;
        tokensBefore = typeof prep.tokensBefore === "number" ? prep.tokensBefore : undefined;
        fileOps = prep.fileOps;
        settings = prep.settings;
        isSplitTurn = Boolean(prep.isSplitTurn);
        previousSummary = prep.previousSummary;

        if (Array.isArray(prep.turnPrefixMessages)) {
          turnPrefixMessages = JSON.parse(JSON.stringify(prep.turnPrefixMessages));
        }

        if (Array.isArray(prep.messagesToSummarize)) {
          messages = JSON.parse(JSON.stringify(prep.messagesToSummarize));
        } else if (Array.isArray(anyObj.branchEntries)) {
          messages = extractMessagesFromSessionEntries(anyObj.branchEntries);
        }
      } else if (Array.isArray(anyObj.messages)) {
        // Direct object with messages
        messages = JSON.parse(JSON.stringify(anyObj.messages));
      } else if (Array.isArray(anyObj)) {
        // Direct array
        if (anyObj.length > 0 && anyObj[0] && ("type" in anyObj[0] || "parentId" in anyObj[0])) {
          messages = extractMessagesFromSessionEntries(anyObj);
        } else {
          messages = JSON.parse(JSON.stringify(anyObj));
        }
      }
    }

    const messagesChars = messages.reduce(
      (sum, m) => sum + safeJsonStringify(m).length,
      0
    );
    const prefixChars = turnPrefixMessages.reduce(
      (sum, m) => sum + safeJsonStringify(m).length,
      0
    );
    const totalChars = messagesChars + prefixChars;
    const finalTokensBefore = tokensBefore ?? Math.ceil(totalChars / 4);

    return {
      messages,
      turnPrefixMessages,
      isSplitTurn,
      previousSummary,
      totalChars,
      tokensBefore: finalTokensBefore,
      firstKeptEntryId,
      fileOps,
      settings,
    };
  }

  toEvidence(snapshot: PiSnapshot): ToolEvidence[] {
    const allMessages = [...snapshot.messages, ...(snapshot.turnPrefixMessages || [])];
    const total = allMessages.length;

    // Map tool results by toolCallId
    const resultMap = new Map<string, { msgIndex: number; msg: PiToolResultMessage }>();
    allMessages.forEach((msg, idx) => {
      if (msg.role === "toolResult" && "toolCallId" in msg) {
        resultMap.set((msg as PiToolResultMessage).toolCallId, {
          msgIndex: idx,
          msg: msg as PiToolResultMessage,
        });
      }
    });

    const evidenceList: ToolEvidence[] = [];
    const matchedToolResultIds = new Set<string>();

    allMessages.forEach((msg, msgIndex) => {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const part of (msg as PiAssistantMessage).content) {
          if (part && typeof part === "object" && (part as any).type === "toolCall") {
            const toolCall = part as PiToolCallContent;
            const res = resultMap.get(toolCall.id);
            if (res) {
              matchedToolResultIds.add(toolCall.id);
            }

            const isPinned =
              msgIndex === 0 ||
              msgIndex >= total - this.recentMessagesPinnedCount ||
              (res && res.msgIndex >= total - this.recentMessagesPinnedCount);

            evidenceList.push({
              id: toolCall.id,
              name: toolCall.name || "unknown",
              input: toolCall.arguments || toolCall.args || {},
              output: res ? res.msg.content : "[No matching tool result]",
              isError: Boolean(res?.msg?.isError),
              replayable: true,
              pinned: Boolean(isPinned),
              sourceRef: `msg_${msgIndex}`,
            });
          }
        }
      }
    });

    // Check for orphan tool results (tool results without matching toolCall)
    // POLICY: Orphan tool results MUST be preserved! Never drop orphan results!
    resultMap.forEach(({ msgIndex, msg }, toolCallId) => {
      if (!matchedToolResultIds.has(toolCallId)) {
        evidenceList.push({
          id: toolCallId,
          name: msg.toolName || "orphan_tool_result",
          input: {},
          output: msg.content,
          isError: Boolean(msg.isError),
          replayable: false,
          pinned: true, // Always pinned to prevent orphan deletion!
          sourceRef: `orphan_msg_${msgIndex}`,
        });
      }
    });

    return evidenceList;
  }

  async apply(snapshot: PiSnapshot, plan: RetentionPlan): Promise<PiApplyResult> {
    const originalMessages = snapshot.messages;
    const originalPrefix = snapshot.turnPrefixMessages || [];
    const charsBefore =
      snapshot.totalChars ||
      [...originalMessages, ...originalPrefix].reduce((sum, m) => sum + safeJsonStringify(m).length, 0);

    const decisionMap = new Map(plan.decisions.map((d) => [d.id, d]));
    const callsToDrop = new Set<string>();
    const callsToTruncate = new Set<string>();

    let keptCount = 0;
    let truncatedCount = 0;
    let droppedCount = 0;
    let totalCalls = 0;

    for (const decision of plan.decisions) {
      totalCalls++;
      if (decision.action === "drop") {
        callsToDrop.add(decision.id);
        droppedCount++;
      } else if (decision.action === "truncate_result") {
        callsToTruncate.add(decision.id);
        truncatedCount++;
      } else {
        keptCount++;
      }
    }

    const retainedToolSummaries: string[] = [];
    const droppedToolSummaries: string[] = [];

    const prune = (messages: PiMessage[]): PiMessage[] => {
      const out: PiMessage[] = [];
      for (const msg of messages) {
        if (msg.role === "toolResult" && "toolCallId" in msg) {
          const toolMsg = msg as PiToolResultMessage;
          if (callsToDrop.has(toolMsg.toolCallId)) {
            // Drop matching tool result in lockstep
            continue;
          }
          if (callsToTruncate.has(toolMsg.toolCallId)) {
            const originalContent = safeJsonStringify(toolMsg.content);
            out.push({
              ...toolMsg,
              content: [
                {
                  type: "text",
                  text: `[Result truncated by Jev: ${originalContent.length} chars omitted]`,
                },
              ],
            });
            continue;
          }
          out.push(msg);
          continue;
        }

        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const assistantMsg = msg as PiAssistantMessage;
          const newContent = assistantMsg.content.filter((part) => {
            if (part && typeof part === "object" && (part as any).type === "toolCall") {
              const toolCall = part as PiToolCallContent;
              if (callsToDrop.has(toolCall.id)) {
                droppedToolSummaries.push(`- Dropped: \`${toolCall.name}\` (${toolCall.id})`);
                return false; // Drop tool call in lockstep
              }
              const decision = decisionMap.get(toolCall.id);
              const truncTag = decision?.action === "truncate_result" ? " [result truncated]" : "";
              retainedToolSummaries.push(`- Retained: \`${toolCall.name}\` (${toolCall.id})${truncTag}`);
            }
            return true;
          });

          // If assistant had tool calls that were dropped and now is empty,
          // omit it or keep placeholder if necessary
          if (newContent.length === 0 && assistantMsg.content.length > 0) {
            continue;
          }

          out.push({
            ...assistantMsg,
            content: newContent,
          });
          continue;
        }

        // Other messages (system, user, opaque, custom) kept verbatim
        out.push(msg);
      }
      return out;
    };

    // Split-turn prefix messages feed evidence too, so decisions must be applied to them as well.
    const newMessages = prune(originalMessages);
    const newTurnPrefixMessages = prune(originalPrefix);

    const charsAfter = [...newMessages, ...newTurnPrefixMessages].reduce(
      (sum, m) => sum + safeJsonStringify(m).length,
      0
    );
    const tokensBefore = snapshot.tokensBefore;
    const savedTokens = Math.ceil(Math.max(0, charsBefore - charsAfter) / 4);
    const tokensAfter = tokensBefore - savedTokens;

    const stats: PiCompactionStats = {
      messagesBefore: originalMessages.length + originalPrefix.length,
      messagesAfter: newMessages.length + newTurnPrefixMessages.length,
      toolCallsBefore: totalCalls,
      toolCallsKept: keptCount,
      toolCallsTruncated: truncatedCount,
      toolCallsDropped: droppedCount,
      charsBefore,
      charsAfter,
      savedChars: Math.max(0, charsBefore - charsAfter),
      tokensBefore,
      tokensAfter,
      savedTokens,
      model: plan.model,
      provider: plan.provider,
      timestamp: plan.createdAt,
    };

    // Build rich, structured markdown summary for Pi's compaction entry
    const summarySections: string[] = [
      `### Jev Context Retention Summary`,
      `- **Jev Provider / Model**: ${plan.provider} (${plan.model})`,
      `- **Tool Decisions**: ${totalCalls} total (${keptCount} kept, ${truncatedCount} truncated, ${droppedCount} dropped in pairs)`,
      `- **Token Savings**: ~${tokensBefore} tokens -> ~${tokensAfter} tokens (saved ~${savedTokens} tokens / ${stats.savedChars} chars)`,
    ];

    if (retainedToolSummaries.length > 0) {
      summarySections.push(`\n**Retained Key Tool Evidence**:\n${retainedToolSummaries.slice(0, 15).join("\n")}`);
    }
    if (droppedToolSummaries.length > 0) {
      summarySections.push(`\n**Omitted Redundant Operations**:\n${droppedToolSummaries.slice(0, 10).join("\n")}`);
    }

    return {
      messages: newMessages,
      turnPrefixMessages: newTurnPrefixMessages,
      summary: summarySections.join("\n"),
      plan,
      stats,
    };
  }
}
