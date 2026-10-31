/**
 * LLM summary — strictly via `anna.tools.invoke` routing to the local
 * Executa tool, which borrows the host LLM through reverse
 * sampling/createMessage. The frontend never calls `anna.llm.complete`,
 * never fetches an HTTP API and never builds the summary itself.
 */

import type { AnnaRuntime } from "./anna";
import type { Note, SummaryData } from "./types";

/** Must match manifest.json required_executas / ui.host_api.tools. */
export const TOOL_ID = "tool-dev-mini-notes-summarizer";
/** Must match the tool name in the Executa `describe` manifest. */
export const TOOL_METHOD = "summarize";

export class SummarizeError extends Error {
  constructor(message: string, public code?: string | number, public details?: unknown) {
    super(message);
    this.name = "SummarizeError";
  }
}

function toSummarizeError(err: any): SummarizeError {
  const code = err?.code ?? err?.error?.code;
  const rawMessage = String(err?.message ?? err?.error?.message ?? err ?? "unknown error");
  // The harness surfaces JSON-RPC errors as "[<code>] <message>".
  const message = code != null && !rawMessage.startsWith("[") ? `[${code}] ${rawMessage}` : rawMessage;
  return new SummarizeError(message, code, err?.details ?? err?.error?.details);
}

export async function summarizeNotes(anna: AnnaRuntime, notes: Note[]): Promise<SummaryData> {
  if (notes.length === 0) {
    return { summary: "", note: "no notes to summarize" };
  }
  let envelope: { result?: unknown };
  try {
    envelope = await anna.tools.invoke({
      tool_id: TOOL_ID,
      method: TOOL_METHOD,
      args: {
        notes: notes.map((n) => ({ order: n.order, text: n.text })),
        max_words: 80,
      },
      timeoutMs: 60_000,
    });
  } catch (err) {
    // e.g. [-32603] harness started with --no-llm  (expected in --no-llm mode)
    throw toSummarizeError(err);
  }

  // The harness resolves `tools.invoke` to the tool's `data` object
  // directly (confirmed against SDK v0.27.0). Older/other harness shapes
  // may wrap it as { result: { success, tool, data } }; handle both.
  const result = envelope as any;
  if (!result || typeof result !== "object") {
    throw new SummarizeError("unexpected tool result shape");
  }
  if ("data" in result) {
    const data = (result as any).data as any;
    if ((result as any).success === false) {
      throw new SummarizeError(String(data ?? result.error ?? "tool failed"));
    }
    return data as SummaryData;
  }
  if ("summary" in result) {
    return result as SummaryData;
  }
  throw new SummarizeError("unexpected tool result shape");
}
