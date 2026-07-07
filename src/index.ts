import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { loadConfig } from "./config.js";
import { decryptText, encryptText, hashSecret } from "./crypto.js";
import { Store, type TokenRow } from "./db.js";
import { createMcpServer, fetchMessage, listChannelMessages, searchMessages } from "./mcp.js";
import { isBlockedEndpoint, loadRegistry } from "./registry.js";
import { exchangeCode, getMe, hasReadScope, tokenRow } from "./traq.js";

const config = loadConfig();
const store = new Store(config.databasePath);
const registry = await loadRegistry(config.traqOpenApiUrl);
const app = new Hono();
const secureCookie = config.publicBaseUrl.startsWith("https://");

const html = (body: string) => `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>traQ MCP</title><style>body{font-family:system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;line-height:1.6}button,a.button{display:inline-block;padding:10px 14px;border:1px solid #222;border-radius:6px;background:#222;color:white;text-decoration:none}code,input{font:inherit}input{width:100%;padding:10px}</style></head><body>${body}</body></html>`;

app.get("/", c => c.html(html(`
  <h1>traQ MCP</h1>
  <p>traQ MCP は、あなたのtraQアカウントでread scopeにより読める情報を、MCPクライアントから取得できるようにするツールです。投稿・編集・削除などのwrite操作はできません。</p>
  <p>MCP URLを追加したクライアントは、あなたのtraQ read権限で情報を取得できます。URLを他人に共有しないでください。OAuth2・token・client管理系の情報は公開しません。</p>
  <p><a class="button" href="/auth/traq/start">traQで登録</a></p>
`)));

app.get("/auth/traq/start", c => {
  const state = randomBytes(32).toString("base64url");
  setCookie(c, "oauth_state", state, { httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/", maxAge: 600 });
  const url = new URL(config.traqOAuthAuthorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.traqClientId);
  url.searchParams.set("redirect_uri", config.traqRedirectUri);
  url.searchParams.set("scope", "read");
  url.searchParams.set("state", state);
  return c.redirect(url.toString());
});

app.get("/auth/traq/callback", async c => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || state !== getCookie(c, "oauth_state")) return c.json({ error: "unauthorized", message: "invalid OAuth state" }, 401);
  const token = await exchangeCode(config, code);
  if (!hasReadScope(token.scope)) return c.json({ error: "unauthorized", message: "unexpected OAuth scope" }, 401);
  const me = await getMe(config, token.access_token);
  const user = store.upsertUser(me.id, me.name ?? me.displayName ?? me.id);
  const row = tokenRow(config, user.id, token);
  store.saveTokens(row);
  const key = store.latestConnection(user.id) ? undefined : store.createConnection(user.id, config.mcpKeyPrefix);
  const sealedKey = sealConnection(row);
  const session = randomBytes(32).toString("base64url");
  store.createWebSession(user.id, session);
  setCookie(c, "session", session, { httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/" });
  if (key) setCookie(c, "new_mcp_key", key, { httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/dashboard", maxAge: 300 });
  setCookie(c, "sealed_mcp_key", sealedKey, { httpOnly: true, secure: secureCookie, sameSite: "Lax", path: "/dashboard", maxAge: 300 });
  return c.redirect("/dashboard");
});

function currentUser(c: Context) {
  const session = getCookie(c, "session");
  return session ? store.userBySession(session) : undefined;
}

app.get("/dashboard", c => {
  const user = currentUser(c);
  if (!user) return c.redirect("/");
  const connection = store.latestConnection(user.id);
  const newKey = getCookie(c, "new_mcp_key");
  const sealedKey = getCookie(c, "sealed_mcp_key");
  const visibleKey = sealedKey ?? (connection?.is_active ? newKey : undefined);
  const mcpUrl = visibleKey ? `${config.publicBaseUrl}/mcp/${visibleKey}` : "key is hidden; register again if needed";
  const chatGptUrl = visibleKey ? `${config.publicBaseUrl}/chatgpt/${visibleKey}` : "key is hidden; register again if needed";
  return c.html(html(`
    <h1>traQ MCP</h1>
    <p>ユーザー: ${escapeHtml(user.traq_name)}</p>
    <label>MCP Server URL</label>
    <input readonly value="${escapeHtml(mcpUrl)}">
    <label>ChatGPT Connector URL</label>
    <input readonly value="${escapeHtml(chatGptUrl)}">
    <p>keyの生値は保存しないため、紛失した場合は再発行してください。</p>
    <form method="post" action="/dashboard/key/regenerate"><button>key再発行</button></form>
    <form method="post" action="/dashboard/key/revoke"><button>key無効化</button></form>
    <p>最終利用日時: ${escapeHtml(connection?.last_used_at ?? "未使用")}</p>
    <p>このURLを追加したMCPクライアントは、あなたのtraQアカウントでread scopeにより読める情報へアクセスできます。このURLを他人に共有しないでください。</p>
  `));
});

app.post("/dashboard/key/regenerate", c => {
  const user = currentUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "login required" }, 401);
  store.regenerateConnection(user.id, config.mcpKeyPrefix);
  const key = sealConnection(store.getTokens(user.id));
  const mcpUrl = `${config.publicBaseUrl}/mcp/${key}`;
  const chatGptUrl = `${config.publicBaseUrl}/chatgpt/${key}`;
  return c.html(html(`
    <h1>traQ MCP</h1>
    <p>新しいMCP Server URLです。この画面を離れるとkeyは再表示できません。</p>
    <input readonly value="${escapeHtml(mcpUrl)}">
    <p>ChatGPT Connector URL</p>
    <input readonly value="${escapeHtml(chatGptUrl)}">
    <p>このURLを他人に共有しないでください。</p>
    <p><a href="/dashboard">dashboardへ戻る</a></p>
  `));
});

app.post("/dashboard/key/revoke", c => {
  const user = currentUser(c);
  if (!user) return c.json({ error: "unauthorized", message: "login required" }, 401);
  store.revokeConnections(user.id);
  return c.redirect("/dashboard");
});

async function handleMcp(c: Context, key?: string, chatGptOnly = false) {
  const safePath = c.req.path.startsWith("/mcp/") ? "/mcp/:key" : c.req.path.startsWith("/chatgpt/") ? "/chatgpt/:key" : c.req.path;
  console.info("mcp_request", {
    path: safePath,
    method: c.req.method,
    hasKey: Boolean(key)
  });
  if (!key) {
    console.info("mcp_response", { path: safePath, method: c.req.method, status: 401, auth: "missing_key" });
    return c.json({ error: "unauthorized", message: "invalid or missing MCP key" }, 401);
  }
  const sealed = openSealedConnection(key);
  const connection = sealed ? undefined : store.activeConnectionByKeyHash(hashSecret(key));
  if (!connection) {
    if (!sealed) {
      console.info("mcp_response", { path: safePath, method: c.req.method, status: 401, auth: "invalid_key" });
      return c.json({ error: "unauthorized", message: "invalid or missing MCP key" }, 401);
    }
    if (chatGptOnly) return handleChatGptMcp(c, 0, 0, sealed);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = createMcpServer(config, store, registry, 0, 0, chatGptOnly, sealed);
    await server.connect(transport);
    const response = await transport.handleRequest(mcpRequest(c.req.raw));
    console.info("mcp_response", { path: safePath, method: c.req.method, status: response.status, auth: "sealed" });
    return response;
  }
  store.touchConnection(connection.id);
  if (chatGptOnly) return handleChatGptMcp(c, connection.user_id, connection.id);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createMcpServer(config, store, registry, connection.user_id, connection.id, chatGptOnly);
  await server.connect(transport);
  const response = await transport.handleRequest(mcpRequest(c.req.raw));
  console.info("mcp_response", {
    path: c.req.path.startsWith("/mcp/") ? "/mcp/:key" : c.req.path.startsWith("/chatgpt/") ? "/chatgpt/:key" : c.req.path,
    method: c.req.method,
    status: response.status
  });
  return response;
}

app.all("/mcp", c => handleMcp(c, c.req.query("key")));
app.all("/mcp/:key", c => handleMcp(c, c.req.param("key")));
app.options("/chatgpt/:key", c => new Response(null, { status: 204 }));
app.all("/chatgpt/:key", c => handleMcp(c, c.req.param("key"), true));

async function handleChatGptMcp(c: Context, userId: number, connectionId: number, statelessToken?: TokenRow) {
  if (c.req.method === "GET") {
    console.info("mcp_response", { path: "/chatgpt/:key", method: c.req.method, status: 200, rpc: "sse_probe" });
    return c.json({ ok: true, tools: chatGptTools() });
  }
  const request = await readRpc(c.req.raw);
  const response = await chatGptRpc(request, userId, connectionId, statelessToken);
  const status = response ? 200 : 202;
  console.info("mcp_response", { path: "/chatgpt/:key", method: c.req.method, status, rpc: request?.method ?? "batch" });
  return response ? c.json(response, status) : new Response(null, { status });
}

async function readRpc(request: Request): Promise<any> {
  const text = await Promise.race([
    request.text(),
    new Promise<string>(resolve => setTimeout(() => resolve(""), 1500))
  ]);
  if (!text) return { jsonrpc: "2.0", id: 0, method: "initialize", params: {} };
  return JSON.parse(text);
}

async function chatGptRpc(request: any, userId: number, connectionId: number, statelessToken?: TokenRow): Promise<any> {
  if (Array.isArray(request)) return Promise.all(request.map(item => chatGptRpc(item, userId, connectionId, statelessToken))).then(items => items.filter(Boolean));
  if (request?.id === undefined || request.id === null) return undefined;
  const ctx = { config, store, userId, connectionId, statelessToken };
  if (request.method === "initialize") {
    return rpcResult(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "traQ MCP", version: "0.1.0" }
    });
  }
  if (request.method === "tools/list") return rpcResult(request.id, { tools: chatGptTools() });
  if (request.method === "tools/call") {
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    const data = name === "search"
      ? await searchMessages(ctx, registry, String(args.query ?? ""))
      : name === "fetch"
        ? await fetchMessage(ctx, registry, String(args.id ?? ""))
        : name === "list_channel_messages"
          ? await listChannelMessages(ctx, registry, String(args.channelId ?? ""), withoutChannelId(args))
          : { error: "tool_not_found" };
    return rpcResult(request.id, { structuredContent: data, content: [{ type: "text", text: JSON.stringify(data) }] });
  }
  return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } };
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function withoutChannelId(args: Record<string, string | number | boolean | undefined>) {
  const { channelId: _channelId, ...query } = args;
  return query;
}

function chatGptTools() {
  return [
    {
      name: "search",
      description: "Search traQ messages.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      outputSchema: { type: "object", properties: { results: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" } }, required: ["id", "title", "url"], additionalProperties: false } } }, required: ["results"], additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: "fetch",
      description: "Fetch one traQ message by ID.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      outputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: "string" }, metadata: { type: "object" } }, required: ["id", "title", "text", "url"], additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: "list_channel_messages",
      description: "List messages in one traQ channel.",
      inputSchema: {
        type: "object",
        properties: {
          channelId: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          order: { type: "string" },
          since: { type: "string" },
          until: { type: "string" }
        },
        required: ["channelId"],
        additionalProperties: false
      },
      outputSchema: { type: "object", properties: { messages: { type: "array", items: { type: "object", additionalProperties: true } }, status: { type: "number" } }, required: ["messages"], additionalProperties: false },
      annotations: { readOnlyHint: true }
    }
  ];
}

function sealConnection(row: TokenRow): string {
  return `${config.mcpKeyPrefix}sealed_${encryptText(config.tokenEncryptionKey, JSON.stringify(row))}`;
}

function openSealedConnection(key: string): TokenRow | undefined {
  const prefix = `${config.mcpKeyPrefix}sealed_`;
  if (!key.startsWith(prefix)) return undefined;
  try {
    return JSON.parse(decryptText(config.tokenEncryptionKey, key.slice(prefix.length))) as TokenRow;
  } catch {
    return undefined;
  }
}

function mcpRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  if (request.method === "POST") headers.set("accept", "application/json, text/event-stream");
  if (request.method === "GET") headers.set("accept", "text/event-stream");
  return new Request(request, { headers });
}

app.onError((err, c) => {
  const safeMessage = err instanceof Error ? err.message.split(":")[0] : "unknown";
  console.error("request_failed", { path: c.req.path.startsWith("/mcp/") ? "/mcp/:key" : c.req.path, error: safeMessage });
  const message = err instanceof Error && err.message === "reauth_required"
    ? { error: "reauth_required", message: "traQ OAuth token refresh failed. Please register again." }
    : { error: "internal_server_error", message: "internal server error" };
  return c.json(message, 500);
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}

console.log(`traQ MCP listening on http://localhost:${config.port}`);
console.log(`loaded ${registry.size} traQ GET endpoints`);
serve({ fetch: app.fetch, port: config.port });

export { app, isBlockedEndpoint };
