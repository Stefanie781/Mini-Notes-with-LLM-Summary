/**
 * UI layer — pure DOM rendering + event wiring. Storage and tool calls
 * are injected so this module stays free of platform concerns.
 */

import type { Note, SummaryData } from "./types";

export interface UiCallbacks {
  onAddNote(text: string): Promise<void>;
  onDeleteNote(id: string): Promise<void>;
  onSummarize(): Promise<void>;
}

export interface UiElements {
  connStatus: HTMLElement;
  standaloneBanner: HTMLElement;
  noteForm: HTMLFormElement;
  noteInput: HTMLInputElement;
  addBtn: HTMLButtonElement;
  noteList: HTMLUListElement;
  noteCount: HTMLElement;
  emptyState: HTMLElement;
  storageError: HTMLElement;
  summarizeBtn: HTMLButtonElement;
  summarizeStatus: HTMLElement;
  summaryPanel: HTMLElement;
  summaryText: HTMLElement;
  summaryMeta: HTMLElement;
  summarizeError: HTMLElement;
}

export function getElements(): UiElements {
  const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    return el as T;
  };
  return {
    connStatus: $("conn-status"),
    standaloneBanner: $("standalone-banner"),
    noteForm: $("note-form") as HTMLFormElement,
    noteInput: $("note-input") as HTMLInputElement,
    addBtn: $("add-btn") as HTMLButtonElement,
    noteList: $("note-list") as HTMLUListElement,
    noteCount: $("note-count"),
    emptyState: $("empty-state"),
    storageError: $("storage-error"),
    summarizeBtn: $("summarize-btn") as HTMLButtonElement,
    summarizeStatus: $("summarize-status"),
    summaryPanel: $("summary-panel"),
    summaryText: $("summary-text"),
    summaryMeta: $("summary-meta"),
    summarizeError: $("summarize-error"),
  };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export class Renderer {
  constructor(private readonly els: UiElements) {}

  setConnected(on: boolean): void {
    const el = this.els.connStatus;
    el.textContent = on ? "Anna" : "offline";
    el.classList.toggle("conn--on", on);
    el.classList.toggle("conn--off", !on);
    el.title = on ? "Connected to Anna (storage Host API + tools)" : "Not connected";
    this.els.standaloneBanner.hidden = on;
  }

  renderNotes(notes: Note[]): void {
    const { noteList, noteCount, emptyState } = this.els;
    noteList.innerHTML = "";
    const sorted = [...notes].sort((a, b) => a.order - b.order);
    noteCount.textContent = sorted.length ? `(${sorted.length})` : "";
    emptyState.hidden = sorted.length > 0;

    for (const note of sorted) {
      const li = document.createElement("li");
      li.className = "note";

      const order = document.createElement("span");
      order.className = "note__order";
      order.textContent = `#${note.order}`;

      const body = document.createElement("div");
      body.className = "note__body";
      const text = document.createElement("div");
      text.className = "note__text";
      text.textContent = note.text;
      const time = document.createElement("div");
      time.className = "note__time";
      time.textContent = formatTime(note.created_at);
      body.append(text, time);

      const del = document.createElement("button");
      del.className = "note__delete";
      del.type = "button";
      del.title = "删除该笔记";
      del.textContent = "✕";
      del.addEventListener("click", () => {
        void this.callbacks?.onDeleteNote(note.id);
      });

      li.append(order, body, del);
      noteList.appendChild(li);
    }
  }

  private callbacks: UiCallbacks | null = null;

  bindCallbacks(cb: UiCallbacks): void {
    this.callbacks = cb;
    this.els.noteForm.addEventListener("submit", (ev) => {
      ev.preventDefault();
      void this.callbacks?.onAddNote(this.els.noteInput.value);
    });
    this.els.summarizeBtn.addEventListener("click", () => {
      void this.callbacks?.onSummarize();
    });
  }

  clearInput(): void {
    this.els.noteInput.value = "";
    this.els.noteInput.focus();
  }

  setAddBusy(busy: boolean): void {
    this.els.addBtn.disabled = busy;
    this.els.addBtn.textContent = busy ? "保存中…" : "添加";
  }

  showStorageError(message: string | null): void {
    const el = this.els.storageError;
    if (message) {
      el.textContent = `存储错误：${message}`;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }

  setSummarizeBusy(busy: boolean): void {
    this.els.summarizeBtn.disabled = busy;
    this.els.summarizeBtn.textContent = busy ? "总结中…" : "✨ Summarize";
    this.els.summarizeStatus.textContent = busy ? "调用 tool-dev-mini-notes-summarizer…" : "";
  }

  showSummary(data: SummaryData): void {
    this.els.summarizeError.hidden = true;
    if (!data.summary && data.note) {
      this.els.summaryText.textContent = data.note;
    } else {
      this.els.summaryText.textContent = data.summary;
    }
    const meta: string[] = [];
    if (data.model) meta.push(`model: ${data.model}`);
    if (typeof data.note_count === "number") meta.push(`notes: ${data.note_count}`);
    if (data.usage?.totalTokens != null) meta.push(`tokens: ${data.usage.totalTokens}`);
    meta.push("via anna.tools.invoke → sampling/createMessage");
    this.els.summaryMeta.textContent = meta.join(" · ");
    this.els.summaryPanel.hidden = false;
  }

  showSummarizeError(message: string): void {
    this.els.summaryPanel.hidden = true;
    this.els.summarizeError.textContent = `Summarize 失败：${message}`;
    this.els.summarizeError.hidden = false;
  }

  /** Clear any previous summary / error before starting a new summarize. */
  resetSummarize(): void {
    this.els.summaryPanel.hidden = true;
    this.els.summarizeError.hidden = true;
    this.els.summarizeError.textContent = "";
  }
}
