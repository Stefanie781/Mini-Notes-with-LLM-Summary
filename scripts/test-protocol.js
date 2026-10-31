#!/usr/bin/env node
/**
 * scripts/test-protocol.js — manual protocol test / evidence generator.
 *
 * Acts as a FAKE ANNA HOST for the Executa tool:
 *   1. spawns the tool (source: `node executas/notes-summarizer/server.js`,
 *      or a packaged binary passed as argv[2]),
 *   2. drives the full JSON-RPC 2.0 stdio conversation:
 *        initialize → describe → invoke(summarize) → health → shutdown,
 *   3. when the tool issues its reverse `sampling/createMessage` request,
 *      answers with a canned completion and records the request as
 *      EVIDENCE that the tool actually initiated sampling,
 *   4. verifies the summary in the invoke result equals the canned
 *      sampling text (i.e. the summary came from sampling, not a local rule).
 *
 * Usage:
 *   node scripts/test-protocol.js                       # test from source
 *   node scripts/test-protocol.js ./dist/staging/bin/mini-notes-summarizer
 *
 * Exit code 0 = all assertions passed.
 */

"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const TOOL_SOURCE = path.join(ROOT, "executas", "notes-summarizer", "server.js");

const binary = process.argv[2] || null;
const command = binary ? [binary] : ["node", TOOL_SOURCE];

const CANNED_SUMMARY =
  "(fake-host sampling) You have 3 action items: follow up with the client tomorrow, fix the login bug, and brainstorm workshop ideas.";

// ─── Fake-host side bookkeeping ──────────────────────────────────────

let nextId = 1;
const pending = new Map(); // our request id -> {resolve, reject, timer}
const samplingRequests = []; // evidence: reverse RPCs the tool issued

function fail(msg) {
  console.error(`\n✗ FAIL: ${msg}`);
  process.exitCode = 1;
}

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    fail(msg);
  }
}

function call(child, method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
    }, 10_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`# Executa protocol test`);
  console.log(`# target: ${binary ?? "node " + TOOL_SOURCE}\n`);

  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });

  child.stderr.on("data", (d) => process.stderr.write(`  [tool stderr] ${d}`));

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const frames = [];
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      fail(`tool wrote non-JSON to stdout: ${trimmed.slice(0, 120)}`);
      return;
    }
    frames.push(msg);

    if ("method" in msg) {
      // Reverse RPC initiated by the tool → fake host answers.
      if (msg.method === "sampling/createMessage") {
        samplingRequests.push(msg);
        const p = msg.params || {};
        const listing = (p.messages || [])
          .map((m) => (m.content && m.content.text) || "")
          .join("\n");
        console.log(`  ← tool issued sampling/createMessage (id=${msg.id})`);
        console.log(`    metadata.executa_invoke_id = ${JSON.stringify((p.metadata || {}).executa_invoke_id)}`);
        console.log(`    prompt: ${JSON.stringify(listing.slice(0, 100))}…`);
        child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              role: "assistant",
              content: { type: "text", text: CANNED_SUMMARY },
              model: "fake-host-model",
              stopReason: "endTurn",
              usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
            },
          }) + "\n",
        );
      } else {
        console.log(`  ← tool issued unexpected reverse RPC: ${msg.method}`);
      }
      return;
    }

    // Response to one of OUR requests.
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(Object.assign(new Error(msg.error.message), { rpc: msg.error }));
      else entry.resolve(msg.result);
    }
  });

  const waitClose = new Promise((resolve) => child.on("close", resolve));

  try {
    // 1) initialize — v2 capability negotiation
    console.log("\n[1] initialize");
    const init = await call(child, "initialize", {
      protocolVersion: "2.0",
      clientInfo: { name: "fake-host", version: "1.0" },
      capabilities: {
        sampling: {
          modalities: ["text"],
          maxTokensPerCall: 8192,
          maxCallsPerInvoke: 8,
          responseFormat: [],
        },
      },
    });
    assert(init && init.protocolVersion === "2.0", "protocolVersion == 2.0");
    assert(
      init && init.client_capabilities && "sampling" in init.client_capabilities,
      "client_capabilities.sampling declared",
    );

    // 2) describe — bare manifest
    console.log("\n[2] describe");
    const manifest = await call(child, "describe", {});
    assert(manifest && manifest.name === "mini-notes-summarizer", "manifest.name");
    assert(Array.isArray(manifest.host_capabilities) && manifest.host_capabilities.includes("llm.sample"),
      "host_capabilities includes llm.sample");
    const tool = manifest.tools && manifest.tools[0];
    assert(tool && tool.name === "summarize", "tools[0].name == summarize");
    assert(Array.isArray(tool && tool.parameters), "tools[0].parameters uses Anna parameters[] form");
    assert(manifest.runtime && typeof manifest.runtime.type === "string", "manifest.runtime present");

    // 3) invoke — must trigger a reverse sampling/createMessage
    console.log("\n[3] invoke(summarize)");
    const invokeId = "fake-invoke-id-1234";
    const invokePromise = call(child, "invoke", {
      tool: "summarize",
      arguments: {
        notes: [
          { order: 1, text: "明天跟客户 follow up" },
          { order: 2, text: "修复登录 bug" },
          { order: 3, text: "Workshop 内容想法" },
        ],
      },
      context: { invoke_id: invokeId },
    });
    const invokeResult = await invokePromise;
    assert(invokeResult && invokeResult.success === true, "invoke result.success == true");
    const data = (invokeResult && invokeResult.data) || {};
    assert(data.summary === CANNED_SUMMARY,
      "summary equals the sampling response text (came from sampling, not a local rule)");
    assert(data.model === "fake-host-model", "summary carries sampling model info");

    // 4) evidence — the reverse RPC was actually issued & carries invoke_id
    console.log("\n[4] sampling evidence");
    assert(samplingRequests.length === 1,
      `tool issued exactly one sampling/createMessage (got ${samplingRequests.length})`);
    const samplingReq = samplingRequests[0];
    if (samplingReq) {
      assert(
        samplingReq.params && samplingReq.params.metadata &&
        samplingReq.params.metadata.executa_invoke_id === invokeId,
        "sampling metadata.executa_invoke_id echoes the parent invoke_id",
      );
      assert(
        samplingReq.params.maxTokens > 0 && Array.isArray(samplingReq.params.messages),
        "sampling request has messages + maxTokens",
      );
      assert(
        samplingReq.params.context && samplingReq.params.context.invoke_id === invokeId,
        "sampling params.context.invoke_id set (reverse-RPC routing)",
      );
    }

    // 5) health + shutdown
    console.log("\n[5] health / shutdown");
    const health = await call(child, "health", {});
    assert(health && (health.status === "ready" || health.status === "healthy"), "health.status ok");
    const shutdown = await call(child, "shutdown", {});
    assert(shutdown && shutdown.ok === true, "shutdown ok");
  } catch (err) {
    fail(`unexpected error: ${err.message}${err.rpc ? ` (rpc=${JSON.stringify(err.rpc)})` : ""}`);
  } finally {
    // Closing stdin == EOF == host-requested shutdown per protocol.
    child.stdin.end();
  }

  const code = await waitClose;
  console.log(`\n# tool exited with code ${code}`);

  // stdout discipline: every frame must have been a single-line JSON object.
  const badFrames = frames.filter(
    (f) => !f || f.jsonrpc !== "2.0" || (f.result === undefined && f.error === undefined && f.method === undefined),
  );
  assert(badFrames.length === 0, "every stdout line was a valid JSON-RPC frame");

  const ok = process.exitCode !== 1;
  console.log(ok ? "\nALL PROTOCOL CHECKS PASSED ✓" : "\nSOME CHECKS FAILED ✗");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  fail(`fatal: ${err.stack || err}`);
  process.exit(1);
});
