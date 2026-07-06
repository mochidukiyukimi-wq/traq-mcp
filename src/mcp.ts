import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import type { Store } from "./db.js";
import { isBlockedEndpoint, publicEndpoint, type Endpoint } from "./registry.js";
import { traqGet, type TraqContext } from "./traq.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

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

export function createMcpServer(config: Config, store: Store, registry: Map<string, Endpoint>, userId: number, connectionId: number): McpServer {
  const ctx = { config, store, userId, connectionId };
  const server = new McpServer({ name: "traQ MCP", version: "0.1.0" });

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
