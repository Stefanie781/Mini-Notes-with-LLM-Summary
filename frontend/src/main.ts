/**
 * Bootstrap — wires the Anna runtime, the storage store, the tool call
 * and the UI together.
 */

import { connectAnna } from "./anna";
import { NotesStore } from "./notesStore";
import { summarizeNotes } from "./summarize";
import { getElements, Renderer } from "./ui";
import type { Note } from "./types";

async function main(): Promise<void> {
  const els = getElements();
  const renderer = new Renderer(els);
  renderer.setConnected(false);

  const anna = await connectAnna();
  renderer.setConnected(anna != null);

  // In-memory fallback ONLY for the standalone browser preview
  // (no Anna host). In that mode persistence is intentionally disabled.
  let previewNotes: Note[] = [];
  const store = anna ? new NotesStore(anna) : null;

  async function loadNotes(): Promise<Note[]> {
    if (!store) return previewNotes;
    return await store.list();
  }

  renderer.bindCallbacks({
    async onAddNote(rawText: string): Promise<void> {
      const text = rawText.trim();
      if (!text) {
        els.noteInput.focus();
        return; // 空输入不能保存
      }
      renderer.showStorageError(null);
      renderer.setAddBusy(true);
      try {
        if (store) {
          await store.add(text); // anna.storage.get + anna.storage.set
        } else {
          previewNotes = [
            ...previewNotes,
            {
              id: crypto.randomUUID(),
              order: previewNotes.length + 1,
              text,
              created_at: new Date().toISOString(),
            },
          ];
        }
        renderer.clearInput(); // 保存后清空输入框
        renderer.renderNotes(await loadNotes());
      } catch (err: any) {
        renderer.showStorageError(err?.message ?? String(err));
      } finally {
        renderer.setAddBusy(false);
      }
    },

    async onDeleteNote(id: string): Promise<void> {
      renderer.showStorageError(null);
      try {
        if (store) {
          await store.remove(id); // anna.storage.set 更新后的列表
        } else {
          previewNotes = previewNotes.filter((n) => n.id !== id);
        }
        renderer.renderNotes(await loadNotes()); // 列表立即更新
      } catch (err: any) {
        renderer.showStorageError(err?.message ?? String(err));
      }
    },

    async onSummarize(): Promise<void> {
      renderer.resetSummarize();
      renderer.setSummarizeBusy(true);
      try {
        if (!anna || !store) {
          throw new Error("未连接 Anna runtime，无法调用 Executa tool");
        }
        // Re-read from Anna storage so the summary reflects what is
        // actually persisted (not just local state).
        const notes = await store.list();
        if (notes.length === 0) {
          renderer.showSummary({ summary: "", note: "没有笔记可总结，先添加几条吧。" });
          return;
        }
        const data = await summarizeNotes(anna, notes); // anna.tools.invoke → Executa → sampling
        renderer.showSummary(data);
      } catch (err: any) {
        renderer.showSummarizeError(err?.message ?? String(err));
      } finally {
        renderer.setSummarizeBusy(false);
      }
    },
  });

  // Initial render from Anna storage (anna.storage.get).
  try {
    renderer.renderNotes(await loadNotes());
  } catch (err: any) {
    renderer.showStorageError(err?.message ?? String(err));
  }

  // Best-effort window title sync (window.* is always allowed).
  try {
    await anna?.window?.set_title?.({ title: "Mini Notes" });
  } catch {
    /* non-fatal */
  }
}

main().catch((err) => console.error("[mini-notes] fatal:", err));
