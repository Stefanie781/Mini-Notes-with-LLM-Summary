#!/usr/bin/env node
/**
 * mini-notes-summarizer — Executa Tool (JSON-RPC 2.0 over stdio).
 *
 * Protocol notes (Anna Executa v2):
 *   - One JSON-RPC frame per line on stdin; every response is a single
 *     line on stdout, flushed immediately. stdout carries ONLY protocol
 *     frames — logs go to stderr.
 *   - The process stays alive reading stdin until EOF (that is the host
 *     asking us to shut down). Never exit after one request.
 *   - `initialize` negotiates protocol v2 and declares
 *     client_capabilities.sampling = {} so the host knows we may issue
 *     reverse RPCs.
 *   - `describe` returns the bare manifest (host_capabilities:
 *     ["llm.sample"], tools[] with Anna `parameters[]` shape).
 *   - `invoke` handles the `summarize` tool: it issues a reverse
 *     `sampling/createMessage` JSON-RPC request to the host and returns
 *     the LLM's text. The summary ALWAYS comes from the host's sampling
 *     response — never from a local rule.
 *   - The same stdin reader receives host-initiated requests (invoke, …)
 *     AND host responses to our reverse RPCs; frames without a `method`
 *     field are responses, matched by `id` against pending promises.
 *
 * Uses Node built-ins only (no npm install needed to run from source).
 */

"use strict";

const readline = require("node:readline");
const crypto = require("node:crypto");

// ─── Identity — must stay consistent with manifest.json, executa.json,
// and the frontend TOOL_ID constant ────────────────────────────────────

const TOOL_ID = "tool-dev-mini-notes-summarizer";
const TOOL_NAME = "summarize";
const PROTOCOL_VERSION_V2 = "2.0";

// ─── Manifest returned by `describe` ─────────────────────────────────

const MANIFEST = {
  name: "mini-notes-summarizer",
  display_name: "Mini Notes Summarizer",
  version: "1.0.0",
  description:
    "Summarizes the Mini Notes app's notes by borrowing the host LLM " +
    "via a reverse sampling/createMessage JSON-RPC call. Never holds an API key.",
  author: "Mini Notes",
  icon: "📝",
  category: "productivity",
  license: "MIT",
  // NEW in v2 — without this entry the host refuses sampling requests
  // with -32008 SAMPLING_NOT_NEGOTIATED.
  host_capabilities: ["llm.sample"],
  tools: [
    {
      name: TOOL_NAME,
      description:
        "Summarize the supplied notes into one short paragraph using the host LLM (sampling).",
      timeout: 60,
      streaming: false,
      // Anna Executa `parameters[]` form (NOT MCP-style input_schema).
      parameters: [
        {
          name: "notes",
          type: "array",
          items: { type: "object" },
          description: "Notes to summarize; each item { order, text }.",
          required: true,
        },
        {
          name: "max_words",
          type: "integer",
          description: "Approximate max words for the summary.",
          required: false,
          default: 80,
        },
      ],
    },
  ],
  runtime: { type: "node", min_version: "18.0.0" },
};

// ─── stdout framing (protocol only; always flush) ────────────────────

function writeFrame(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function response(id, { result, error } = {}) {
  const out = { jsonrpc: "2.0", id };
  if (error) out.error = error;
  else out.result = result;
  return out;
}

function log(...args) {
  process.stderr.write(args.join(" ") + "\n");
}

// ─── Sampling client — reverse JSON-RPC sampling/createMessage ───────
//
// Wire flow:
//   host                              us
//   ─── invoke(id=42) ─────────────►
//   ◄── sampling/createMessage(id=A) ──
//   ─── result|error (id=A) ───────►
//   ◄── invoke result (id=42) ──────

class SamplingError extends Error {
  constructor(code, message, data) {
    super(`[${code}] ${message}`);
    this.name = "SamplingError";
    this.code = code;
    this.data = data || {};
  }
}

class SamplingClient {
  constructor(writeFrameFn) {
    this._writeFrame = writeFrameFn;
    this._pending = new Map(); // id -> {resolve, reject, timer}
    this._disabledReason = null;
  }

  disable(reason) {
    this._disabledReason = reason;
  }

  createMessage(params, invokeId) {
    if (this._disabledReason) {
      return Promise.reject(
        new SamplingError(-32008, this._disabledReason),
      );
    }
    const {
      messages,
      maxTokens,
      systemPrompt,
      temperature,
      stopSequences,
      modelPreferences,
      includeContext = "none",
      metadata,
      timeoutMs = 90_000,
    } = params || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return Promise.reject(new TypeError("messages must be a non-empty array"));
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      return Promise.reject(new TypeError("maxTokens must be a positive integer"));
    }

    const reqId = crypto.randomUUID();
    const rpcParams = { messages, maxTokens, includeContext };
    if (systemPrompt != null) rpcParams.systemPrompt = systemPrompt;
    if (temperature != null) rpcParams.temperature = temperature;
    if (stopSequences) rpcParams.stopSequences = stopSequences;
    if (modelPreferences) rpcParams.modelPreferences = modelPreferences;
    if (metadata) rpcParams.metadata = metadata;
    // Echo the parent invoke's id so the host can route the reverse RPC
    // to the right invoke context (token, deadline, quota).
    if (invokeId) rpcParams.context = { invoke_id: invokeId };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.delete(reqId)) {
          reject(
            new SamplingError(
              -32005,
              `sampling/createMessage timed out after ${timeoutMs}ms`,
            ),
          );
        }
      }, timeoutMs);
      this._pending.set(reqId, { resolve, reject, timer });

      try {
        this._writeFrame({
          jsonrpc: "2.0",
          id: reqId,
          method: "sampling/createMessage",
          params: rpcParams,
        });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(reqId);
        reject(err);
      }
    });
  }

  /** Resolve a pending reverse-RPC request from a parsed stdin frame. */
  dispatchResponse(msg) {
    if (!msg || typeof msg !== "object" || "method" in msg) return false;
    const id = msg.id;
    if (id == null) return false;
    const pending = this._pending.get(id);
    if (!pending) return false;
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new SamplingError(
          Number(msg.error.code) || -32603,
          String(msg.error.message || "unknown error"),
          msg.error.data,
        ),
      );
    } else {
      pending.resolve(msg.result || {});
    }
    return true;
  }
}

const sampling = new SamplingClient(writeFrame);

// ─── Tool implementation ─────────────────────────────────────────────

function normalizeNotes(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ order: out.length + 1, text: item.trim() });
    } else if (item && typeof item === "object" && typeof item.text === "string") {
      const order = Number(item.order);
      out.push({
        order: Number.isFinite(order) ? order : out.length + 1,
        text: item.text.trim(),
      });
    }
  }
  return out.filter((n) => n.text.length > 0);
}

async function handleSummarize(args, invokeId) {
  const notes = normalizeNotes(args.notes);
  if (notes.length === 0) {
    return { summary: "", note_count: 0, note: "no notes to summarize" };
  }

  const maxWords = Math.max(20, Math.min(400, Number(args.max_words) || 80));
  const maxTokens = Math.max(64, Math.min(1024, maxWords * 5));
  const listing = notes
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((n) => `${n.order}. ${n.text}`)
    .join("\n");

  log(`summarize: issuing sampling/createMessage for ${notes.length} note(s), invoke_id=${invokeId || "(none)"}`);

  const result = await sampling.createMessage(
    {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Summarize the following ${notes.length} note(s) in at most ` +
              `${maxWords} words as one concise paragraph. Return only the ` +
              `summary, no preamble.\n\n---\n${listing}`,
          },
        },
      ],
      maxTokens,
      systemPrompt: "You are a concise editorial assistant summarizing short personal notes.",
      // No modelPreferences → host uses the user's preferred model.
      metadata: { executa_invoke_id: invokeId, tool: TOOL_NAME },
      timeoutMs: 55_000,
    },
    invokeId,
  );

  const content = result.content || {};
  return {
    summary: content && content.type === "text" ? content.text : "",
    model: result.model,
    usage: result.usage,
    stopReason: result.stopReason,
    note_count: notes.length,
  };
}

// ─── JSON-RPC method handlers ────────────────────────────────────────

function handleInitialize(reqId, params) {
  const offered = (params && params.protocolVersion) || "1.1";
  const v2 = offered === PROTOCOL_VERSION_V2;
  if (!v2) {
    sampling.disable(
      `host did not negotiate v2 (offered protocolVersion=${offered}); ` +
        "sampling/createMessage requires Executa protocol 2.0",
    );
    log("initialize: host is v1 — sampling disabled");
  } else {
    log("initialize: negotiated protocol v2, sampling enabled");
  }
  return response(reqId, {
    result: {
      protocolVersion: v2 ? PROTOCOL_VERSION_V2 : "1.1",
      serverInfo: { name: MANIFEST.name, version: MANIFEST.version },
      // Declare that we WILL use host sampling (v2 capability handshake).
      client_capabilities: v2 ? { sampling: {} } : {},
      capabilities: {},
    },
  });
}

async function handleInvoke(reqId, params) {
  const tool = params && params.tool;
  const args = (params && params.arguments) || {};
  // v2 hosts inject the invoke id under params.context.invoke_id; older
  // hosts may put it directly on params. We must echo it in reverse RPCs.
  const invokeId =
    (params && params.context && params.context.invoke_id) ||
    (params && params.invoke_id) ||
    "";

  if (tool !== TOOL_NAME) {
    return response(reqId, {
      error: { code: -32601, message: `Unknown tool: ${tool}` },
    });
  }

  try {
    const data = await handleSummarize(args, invokeId);
    return response(reqId, { result: { success: true, tool: TOOL_NAME, data } });
  } catch (err) {
    if (err instanceof SamplingError) {
      // Propagate the host's sampling error verbatim (e.g. the
      // [-32603] "harness started with --no-llm" error in `anna-app dev --no-llm`).
      return response(reqId, {
        error: { code: err.code, message: err.message, data: err.data },
      });
    }
    return response(reqId, {
      error: { code: -32603, message: `Tool execution failed: ${err.message}` },
    });
  }
}

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    writeFrame(response(null, { error: { code: -32700, message: "Parse error" } }));
    return;
  }

  // Frame without `method` → a response to one of OUR reverse RPCs.
  if (!("method" in msg)) {
    if (!sampling.dispatchResponse(msg)) {
      log(`unmatched response id=${JSON.stringify(msg.id)}`);
    }
    return;
  }

  const { method, id: reqId } = msg;
  const params = msg.params || {};
  let resp;
  switch (method) {
    case "initialize":
      resp = handleInitialize(reqId, params);
      break;
    case "describe":
      resp = response(reqId, { result: MANIFEST });
      break;
    case "invoke":
      resp = await handleInvoke(reqId, params);
      break;
    case "health":
      resp = response(reqId, {
        result: { status: "ready", message: "", details: { version: MANIFEST.version, tool_id: TOOL_ID } },
      });
      break;
    case "shutdown":
      resp = response(reqId, { result: { ok: true } });
      break;
    default:
      resp = response(reqId, {
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
  if (reqId != null) writeFrame(resp);
}

// ─── Main loop — read stdin until EOF ────────────────────────────────

function main() {
  log(`mini-notes-summarizer started (pid=${process.pid}, tool_id=${TOOL_ID})`);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Fire-and-forget: an invoke may block on a reverse RPC while new
    // frames keep arriving on the same stdin reader.
    handleMessage(trimmed).catch((err) => {
      log(`handler error: ${err.stack || err}`);
    });
  });
  rl.on("close", () => {
    log("stdin EOF — shutting down");
    process.exit(0);
  });
}

main();
