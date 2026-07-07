import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import type { Store, TokenRow } from "./db.js";
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

type ChannelSummary = { id: string; name: string; path: string; parentId?: string };

export function flattenChannels(body: unknown): ChannelSummary[] {
  const rows = Array.isArray(body) ? body : Object.values((body ?? {}) as Record<string, unknown>).flatMap(value => Array.isArray(value) ? value : []);
  const channels = rows
    .filter((item: any) => item?.id && item?.name)
    .map((item: any) => ({ id: String(item.id), name: String(item.name), parentId: item.parentId ? String(item.parentId) : undefined }));
  const byId = new Map(channels.map(channel => [channel.id, channel]));
  const pathOf = (channel: { id: string; name: string; parentId?: string }): string => {
    const parent = channel.parentId ? byId.get(channel.parentId) : undefined;
    return parent ? `${pathOf(parent)}/${channel.name}` : channel.name;
  };
  return channels.map(channel => ({ ...channel, path: pathOf(channel) }));
}

export async function searchMessages(ctx: TraqContext, registry: Map<string, Endpoint>, query: string) {
  const endpoint = registry.get("/messages");
  if (!endpoint) return { results: [] };
  const result = await traqGet(ctx, endpoint, {}, { word: query, limit: 10 });
  ctx.store.logTool(ctx.connectionId, "search", "/messages", result.status, result.resultCount);
  const hits = Array.isArray((result.body as any)?.hits) ? (result.body as any).hits : [];
  return { results: hits.map((m: any) => ({ id: String(m.id), title: messageTitle(m), url: messageUrl(String(m.id)) })) };
}

export async function fetchMessage(ctx: TraqContext, registry: Map<string, Endpoint>, id: string) {
  const endpoint = registry.get("/messages/{messageId}");
  if (!endpoint) return { id, title: `traQ message ${id}`, text: "message endpoint is not available", url: messageUrl(id) };
  const result = await traqGet(ctx, endpoint, { messageId: id }, {});
  ctx.store.logTool(ctx.connectionId, "fetch", "/messages/{messageId}", result.status, result.resultCount);
  const message = result.body as any;
  return {
    id,
    title: messageTitle(message),
    text: typeof message?.content === "string" ? message.content : JSON.stringify(message),
    url: messageUrl(id),
    metadata: { channelId: message?.channelId, userId: message?.userId, createdAt: message?.createdAt }
  };
}

export async function findChannels(ctx: TraqContext, registry: Map<string, Endpoint>, query: string, limit = 10) {
  const endpoint = registry.get("/channels");
  if (!endpoint) return { channels: [] };
  const result = await traqGet(ctx, endpoint, {}, {});
  ctx.store.logTool(ctx.connectionId, "find_channels", "/channels", result.status, result.resultCount);
  const needle = query.toLowerCase().replace(/^#|^\//, "");
  return {
    channels: flattenChannels(result.body)
      .filter(channel => !needle || channel.id === query || channel.name.toLowerCase().includes(needle) || channel.path.toLowerCase().includes(needle))
      .slice(0, limit)
  };
}

export async function listChannelMessages(ctx: TraqContext, registry: Map<string, Endpoint>, channelId: string, query: Record<string, string | number | boolean | undefined> = {}) {
  if (!channelId) return { messages: [], status: 404, error: "channel_not_found" };
  const endpoint = registry.get("/channels/{channelId}/messages");
  if (!endpoint) return { messages: [] };
  const result = await traqGet(ctx, endpoint, { channelId }, query);
  ctx.store.logTool(ctx.connectionId, "list_channel_messages", "/channels/{channelId}/messages", result.status, result.resultCount);
  return { messages: Array.isArray(result.body) ? result.body : [], status: result.status };
}

export function createMcpServer(config: Config, store: Store, registry: Map<string, Endpoint>, userId: number, connectionId: number, chatGptOnly = false, statelessToken?: TokenRow): McpServer {
  const ctx = { config, store, userId, connectionId, statelessToken };
  const server = new McpServer({ name: "traQ MCP", version: "0.1.0" });

  server.registerTool("search", {
    description: "Search traQ messages. Required compatibility tool for ChatGPT connectors.",
    inputSchema: { query: z.string() },
    outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string() })) },
    annotations: readOnly
  }, async ({ query }) => {
    return structured(await searchMessages(ctx, registry, query));
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
    return structured(await fetchMessage(ctx, registry, id));
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
