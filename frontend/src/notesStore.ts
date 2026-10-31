/**
 * Notes persistence — strictly via the Anna storage Host API
 * (anna.storage.get / anna.storage.set).
 *
 * No localStorage / IndexedDB / filesystem / custom HTTP anywhere:
 * in local dev the harness backs this with the legacy in-memory
 * runtime_state; in production it is Anna Persistent Storage (APS).
 */

import type { AnnaRuntime } from "./anna";
import type { Note } from "./types";

export const NOTES_STORAGE_KEY = "mini-notes:notes";

function isNote(value: unknown): value is Note {
  if (!value || typeof value !== "object") return false;
  const n = value as Record<string, unknown>;
  return typeof n.id === "string" && typeof n.text === "string" && typeof n.order === "number";
}

export class NotesStore {
  constructor(private readonly anna: AnnaRuntime) {}

  /** Read the notes array from anna.storage. */
  async list(): Promise<Note[]> {
    const res: any = await this.anna.storage.get({ key: NOTES_STORAGE_KEY });
    const value = res?.value;
    return Array.isArray(value) ? value.filter(isNote) : [];
  }

  /** Append a note (empty text is rejected by the caller) and persist. */
  async add(text: string): Promise<Note[]> {
    const notes = await this.list();
    const nextOrder = notes.reduce((max, n) => Math.max(max, n.order), 0) + 1;
    const note: Note = {
      id: crypto.randomUUID(),
      order: nextOrder,
      text,
      created_at: new Date().toISOString(),
    };
    const next = [...notes, note];
    await this.anna.storage.set({ key: NOTES_STORAGE_KEY, value: next });
    return next;
  }

  /** Delete by id and persist the remaining list. */
  async remove(id: string): Promise<Note[]> {
    const notes = await this.list();
    const next = notes.filter((n) => n.id !== id);
    await this.anna.storage.set({ key: NOTES_STORAGE_KEY, value: next });
    return next;
  }
}
