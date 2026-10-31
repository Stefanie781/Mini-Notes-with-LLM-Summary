/** Domain types shared across the frontend modules. */

export interface Note {
  id: string;
  /** 1-based insertion order. */
  order: number;
  text: string;
  created_at: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Payload returned by the Executa tool's `summarize` invoke. */
export interface SummaryData {
  summary: string;
  model?: string;
  usage?: Usage;
  stopReason?: string;
  note_count?: number;
  note?: string;
}
