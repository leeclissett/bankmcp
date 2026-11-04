// The HTTP surface as a client on the internet sees it: every MCP route needs a bearer token,
// a bad token is answered 401 with a challenge, and the SDK's request limits apply.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

for (const k of ["EB_APP_ID", "EB_PRIVATE_KEY", "EB_PRIVATE_KEY_PATH", "ADMIN_PASSWORD_HASH", "NOTIFY_WEBHOOK_URL"]) delete process.env[k];
process.env.ADMIN_PASSWORD = "correct horse battery";
process.env.BASE_URL = "http://localhost:8080";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bank-http-"));
const { createApp } = await import("../src/app.ts");
const { store } = await import("../src/store.ts");
const { MAX_TOOL_INPUT_ELEMENTS } = await import("../src/mcp.ts");

const app = createApp({ remote: true });
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const accessToken = randomBytes(32).toString("base64url");
store().update((d) => {
  d.oauth.tokens[createHash("sha256").update(accessToken).digest("hex")] = { kind: "access", client_id: "test", scopes: [], expires: Math.floor(Date.now() / 1000) + 600 };
});

const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const initialize = rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, challenge: res.headers.get("www-authenticate"), json: (await res.json().catch(() => undefined)) as any };
}

test("every MCP route refuses a request without a token with 401 and a challenge", async () => {
  for (const path of ["/mcp", "/"]) {
    const r = await post(path, initialize);
    assert.equal(r.status, 401, `POST ${path}`);
    assert.match(r.challenge ?? "", /^Bearer .*resource_metadata="http:\/\/localhost:8080\/\.well-known\/oauth-protected-resource\/mcp"/);
  }
  for (const method of ["GET", "DELETE"]) {
    const res = await fetch(base + "/mcp", { method });
    assert.equal(res.status, 401, `${method} /mcp`);
  }
});

test("an unknown token is invalid_token with 401, so clients know to refresh", async () => {
  const r = await post("/mcp", initialize, "not-a-token");
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "invalid_token");
  assert.match(r.challenge ?? "", /error="invalid_token"/);
});

test("the token is checked before the body is read", async () => {
  const r = await post("/mcp", JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }));
  assert.equal(r.status, 401);
});

test("a valid token can initialize and list tools", async () => {
  const init = await post("/mcp", initialize, accessToken);
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, "bank");
  const list = await post("/mcp", rpc("tools/list", {}, 2), accessToken);
  const names = (list.json.result.tools as { name: string }[]).map((t) => t.name);
  for (const n of ["list_accounts", "get_balances", "get_transactions"]) assert.ok(names.includes(n), n);
});

test("a JSON-RPC batch over 100 messages is refused (GHSA-f897-62hf-6gxq)", async () => {
  const batch = Array.from({ length: 101 }, (_, i) => rpc("ping", {}, i + 1));
  const r = await post("/mcp", batch, accessToken);
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, -32600);
});

test("oversized tool arguments are refused before the tool runs (GHSA-46jr-4wx8-v453)", async () => {
  const accounts = Array.from({ length: MAX_TOOL_INPUT_ELEMENTS + 1 }, (_, i) => `a${i}`);
  const r = await post("/mcp", rpc("tools/call", { name: "monthly_summary", arguments: { accounts } }, 3), accessToken);
  assert.equal(r.status, 200);
  assert.equal(r.json.result.isError, true);
  assert.match(r.json.result.content[0].text, new RegExp(`more than the maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`));

  const small = await post("/mcp", rpc("tools/call", { name: "monthly_summary", arguments: { accounts: ["a1", "a2"] } }, 4), accessToken);
  assert.doesNotMatch(JSON.stringify(small.json), /more than the maximum/);
});
