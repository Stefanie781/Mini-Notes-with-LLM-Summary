/**
 * Anna App Runtime connection layer.
 *
 * The SDK is served by the Anna host at runtime
 * (/static/anna-apps/_sdk/latest/index.js) — it must NEVER be bundled,
 * hence the runtime dynamic import. When the page is opened outside the
 * Anna iframe (plain browser preview) `connect()` fails and we degrade
 * to a read-only standalone preview.
 */

export interface AnnaRuntime {
  storage: {
    get(args: { key: string }): Promise<{ value?: unknown; exists?: boolean }>;
    set(args: { key: string; value: unknown }): Promise<unknown>;
    delete?(args: { key: string }): Promise<unknown>;
    list?(args: { prefix?: string; limit?: number }): Promise<unknown>;
  };
  tools: {
    invoke(args: {
      tool_id: string;
      method?: string;
      args: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<{ result?: unknown }>;
  };
  window?: {
    set_title?(args: { title: string }): Promise<unknown>;
  };
}

const SDK_URL = "/static/anna-apps/_sdk/latest/index.js";

let runtime: AnnaRuntime | null = null;

/** Connect to the Anna host via the official runtime SDK. */
export async function connectAnna(): Promise<AnnaRuntime | null> {
  if (runtime) return runtime;
  try {
    // @vite-ignore: keep the host-served SDK out of the bundle.
    const mod: any = await import(/* @vite-ignore */ SDK_URL);
    const anna = await mod.AnnaAppRuntime.connect();
    runtime = anna as AnnaRuntime;
  } catch (err) {
    console.warn("[mini-notes] Anna runtime unavailable — standalone preview:", err);
    runtime = null;
  }
  return runtime;
}

export function getAnna(): AnnaRuntime | null {
  return runtime;
}
