import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { isBlockedEndpoint, publicEndpoint, type Endpoint } from "./registry.js";
import { traqGet, type TraqContext } from "./traq.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const structured = (value: Record<string, unknown>) => ({
  structuredContent: value,
  content: [{ type: "text" as const, text: JSON.stringify(value) }]
});

const genericInput = {
  path: z.string(),
  params: z.record(z.string(), z.string()).default({}),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.undefined()])).default({})
};

const readOnly = { readOnlyHint: true };

async function callTraqGet(ctx: TraqContext, registry: Map<string, Endpoint>, toolName: string, path: string, params = {}, query = {}) {
  const endpoint = registry.get(path);
  if (!endpoint) {
    const blocked = isBlockedEndpoint(path)
      ? { error: "auth_management_endpoint_blocked", message: "OAuth2, token, and client management endpoints are not exposed by this MCP server" }
      : { error: "endpoint_not_allowed", message: "this endpoint is not allowed" };
    ctx.store.logTool(ctx.connectionId, toolName, path, 403);
    return json(blocked);
  }
  const result = await traqGet(ctx, endpoint, params, query);
  ctx.store.logTool(ctx.connectionId, toolName, path, result.status, result.resultCount);
  return json({ data: result.body, meta: { path, query, returned: result.resultCount } });
}

const messageUrl = (id: string) => `https://q.trap.jp/messages/${encodeURIComponent(id)}`;

function messageTitle(message: any): string {
  return message?.content ? String(message.content).split(/\r?\n/, 1)[0].slice(0, 80) : `traQ message ${message?.id ?? ""}`;
}

export function createMcpServer(config: Config, store: Store, registry: Map<string, Endpoint>, userId: number, connectionId: number, chatGptOnly = false): McpServer {
  const ctx = { config, store, userId, connectionId };
  const server = new McpServer({ name: "traQ MCP", version: "0.1.0" });

  server.registerTool("search", {
    description: "Search traQ messages. Required compatibility tool for ChatGPT connectors.",
    inputSchema: { query: z.string() },
    outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) },
    annotations: readOnly
  }, async ({ query }) => {
    const endpoint = registry.get("/messages");
    if (!endpoint) return structured({ results: [] });
    const result = await traqGet(ctx, endpoint, {}, { word: query, limit: 10 });
    ctx.store.logTool(ctx.connectionId, "search", "/messages", result.status, result.resultCount);
    const hits = Array.isArray((result.body as any)?.hits) ? (result.body as any).hits : [];
    return structured({ results: hits.map((m: any) => ({ id: String(m.id), title: messageTitle(m), url: messageUrl(String(m.id)) })) });
  });

  server.registerTool("fetch", {
    description: "Fetch one traQ message by ID. Required compatibility tool for ChatGPT connectors.",
    inputSchema: { id: z.string() },
    outputSchema: {
      id: z.string(),
      title: z.string(),
      text: z.string(),
      url: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional()
    },
    annotations: readOnly
  }, async ({ id }) => {
    const endpoint = registry.get("/messages/{messageId}");
    if (!endpoint) return structured({ id, title: `traQ message ${id}`, text: "message endpoint is not available", url: messageUrl(id) });
    const result = await traqGet(ctx, endpoint, { messageId: id }, {});
    ctx.store.logTool(ctx.connectionId, "fetch", "/messages/{messageId}", result.status, result.resultCount);
    const message = result.body as any;
    return structured({
      id,
      title: messageTitle(message),
      text: typeof message?.content === "string" ? message.content : JSON.stringify(message),
      url: messageUrl(id),
      metadata: { channelId: message?.channelId, userId: message?.userId, createdAt: message?.createdAt }
    });
  });

  if (chatGptOnly) return server;

  server.registerTool("traq_get", {
    description: "Call an allowed traQ API v3 GET endpoint.",
    inputSchema: genericInput,
    annotations: readOnly
  }, ({ path, params, query }) => callTraqGet(ctx, registry, "traq_get", path, params, query));

  server.registerTool("traq_list_endpoints", {
    description: "List traQ GET endpoints exposed by this MCP server.",
    annotations: readOnly
  }, async () => json([...registry.values()].map(publicEndpoint)));

  server.registerTool("traq_get_endpoint_schema", {
    description: "Get schema details for one exposed traQ GET endpoint.",
    inputSchema: { path: z.string() },
    annotations: readOnly
  }, async ({ path }) => {
    const endpoint = registry.get(path);
    return json(endpoint ? publicEndpoint(endpoint) : { error: "endpoint_not_allowed", message: "this endpoint is not allowed" });
  });

  const dedicated: [string, string, Record<string, string>?][] = [
    ["traq_get_channels", "/channels"],
    ["traq_get_channel", "/channels/{channelId}"],
    ["traq_get_channel_messages", "/channels/{channelId}/messages"],
    ["traq_search_messages", "/messages"],
    ["traq_get_message", "/messages/{messageId}"],
    ["traq_get_users", "/users"],
    ["traq_get_user", "/users/{userId}"],
    ["traq_get_files", "/files"],
    ["traq_get_file", "/files/{fileId}"],
    ["traq_get_stamps", "/stamps"],
    ["traq_get_stamp", "/stamps/{stampId}"],
    ["traq_get_user_groups", "/groups"]
  ];
  for (const [name, path] of dedicated) {
    server.registerTool(name, {
      description: `Shortcut for GET ${path}`,
      inputSchema: { params: genericInput.params, query: genericInput.query },
      annotations: readOnly
    }, ({ params, query }) => callTraqGet(ctx, registry, name, path, params, query));
  }

  return server;
}
