import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import type { Store, TokenRow } from "./db.js";
import {
  ReaderError,
  TraqReader,
  type MessageFiltersInput,
  type SearchMessagesInput
} from "./reader.js";
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

const filterInput = {
  channelId: z.string().optional(),
  channelPath: z.string().optional(),
  userId: z.string().optional(),
  username: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  includeBots: z.boolean().optional()
};

const userSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string().optional(),
  isBot: z.boolean().optional()
});

const channelSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string().optional(),
  parentId: z.string().optional()
});

const messageSchema = z.object({
  id: z.string(),
  text: z.string(),
  renderedText: z.string().optional(),
  user: userSchema,
  channel: channelSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  parentMessageId: z.string().optional(),
  threadId: z.string().optional(),
  url: z.string(),
  attachments: z.array(z.object({ id: z.string(), url: z.string() })),
  stamps: z.array(z.unknown())
});

const appliedFiltersSchema = z.object({
  channelId: z.string().optional(),
  channelPath: z.string().optional(),
  userId: z.string().optional(),
  username: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
  order: z.enum(["asc", "desc"]),
  includeBots: z.boolean()
});

const pageOutput = {
  messages: z.array(messageSchema),
  nextCursor: z.string().optional(),
  appliedFilters: appliedFiltersSchema
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

export function createReader(ctx: TraqContext, registry: Map<string, Endpoint>): TraqReader {
  return new TraqReader(async (path, params, query) => {
    const endpoint = registry.get(path);
    if (!endpoint) throw new ReaderError("endpoint_not_allowed", `GET ${path} is not available`, 500);
    return traqGet(ctx, endpoint, params, query);
  });
}

export async function executeReaderTool(
  ctx: TraqContext,
  registry: Map<string, Endpoint>,
  name: string,
  args: Record<string, any>
): Promise<Record<string, unknown>> {
  const reader = createReader(ctx, registry);
  let result: Record<string, unknown>;

  if (name === "resolve_user") result = await reader.resolveUser(String(args.username ?? ""));
  else if (name === "resolve_channel") result = await reader.resolveChannel(String(args.path ?? ""));
  else if (name === "list_messages") result = await reader.listMessages(args as MessageFiltersInput);
  else if (name === "search_messages") result = await reader.searchMessages(args as SearchMessagesInput);
  else if (name === "fetch_message") result = await reader.fetchMessage(String(args.id ?? ""));
  else if (name === "list_channel_messages") {
    result = await reader.listMessages({
      channelId: args.channelId,
      channelPath: args.channelPath ?? args.channelName,
      after: args.after ?? args.since,
      before: args.before ?? args.until,
      limit: args.limit,
      cursor: args.cursor,
      order: args.order,
      includeBots: args.includeBots
    });
  } else if (name === "search") {
    const page = await reader.searchMessages(args as SearchMessagesInput);
    result = {
      results: page.messages.map(message => ({
        id: message.id,
        title: `@${message.user.username} in #${message.channel.path} at ${message.createdAt}`,
        url: message.url,
        userId: message.user.id,
        channelId: message.channel.id,
        createdAt: message.createdAt
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      appliedFilters: page.appliedFilters
    };
  } else if (name === "fetch") {
    const message = await reader.fetchMessage(String(args.id ?? ""));
    result = {
      id: message.id,
      title: `@${message.user.username} in #${message.channel.path} at ${message.createdAt}`,
      text: message.text,
      url: message.url,
      metadata: message
    };
  } else throw new ReaderError("tool_not_found", `tool '${name}' was not found`, 404);

  ctx.store.logTool(ctx.connectionId, name, undefined, 200, Array.isArray((result as any).messages) ? (result as any).messages.length : undefined);
  return result;
}

export function readerError(error: unknown): Record<string, unknown> {
  if (error instanceof ReaderError) return error.toJSON();
  if (error instanceof Error && error.message === "reauth_required") {
    return { error: "reauth_required", message: "traQ OAuth token refresh failed. Please register again.", status: 401 };
  }
  return { error: "internal_server_error", message: "internal server error", status: 500 };
}

function toolHandler(ctx: TraqContext, registry: Map<string, Endpoint>, name: string) {
  return async (args: Record<string, any>) => {
    try {
      return structured(await executeReaderTool(ctx, registry, name, args));
    } catch (error) {
      const payload = readerError(error);
      return { ...structured(payload), isError: true };
    }
  };
}

export function createMcpServer(config: Config, store: Store, registry: Map<string, Endpoint>, userId: number, connectionId: number, chatGptOnly = false, statelessToken?: TokenRow): McpServer {
  const ctx = { config, store, userId, connectionId, statelessToken };
  const server = new McpServer({ name: "traQ Reader MCP", version: "0.2.0" });

  server.registerTool("search", {
    description: "Compatibility search. Use structured username/userId, channelPath/channelId, after, before and includeBots arguments; do not put from: or in: syntax in query.",
    inputSchema: { query: z.string(), ...filterInput },
    annotations: readOnly
  }, toolHandler(ctx, registry, "search") as any);

  server.registerTool("fetch", {
    description: "Compatibility fetch for one message. For the common Reader Message type, use fetch_message.",
    inputSchema: { id: z.string() },
    annotations: readOnly
  }, toolHandler(ctx, registry, "fetch") as any);

  server.registerTool("resolve_user", {
    description: "Resolve an exact traQ username to userId. Returns user_not_found instead of running an unrelated search.",
    inputSchema: { username: z.string() },
    outputSchema: { id: z.string(), username: z.string(), displayName: z.string().optional(), isBot: z.boolean().optional() },
    annotations: readOnly
  }, toolHandler(ctx, registry, "resolve_user") as any);

  server.registerTool("resolve_channel", {
    description: "Resolve an exact human-readable traQ channel path to channelId. Returns channel_not_found on failure.",
    inputSchema: { path: z.string() },
    outputSchema: { id: z.string(), path: z.string(), name: z.string().optional(), parentId: z.string().optional() },
    annotations: readOnly
  }, toolHandler(ctx, registry, "resolve_channel") as any);

  server.registerTool("list_messages", {
    description: "List traQ history. Specify user, channel, period and order with structured arguments; filters are re-verified before any message is returned.",
    inputSchema: filterInput,
    outputSchema: pageOutput,
    annotations: readOnly
  }, toolHandler(ctx, registry, "list_messages") as any);

  server.registerTool("search_messages", {
    description: "Search traQ message text with optional structured user, channel, period, order and bot filters. Never put from: or in: filters inside query.",
    inputSchema: { query: z.string().optional(), ...filterInput },
    outputSchema: pageOutput,
    annotations: readOnly
  }, toolHandler(ctx, registry, "search_messages") as any);

  server.registerTool("fetch_message", {
    description: "Fetch one traQ message using the same normalized Message type returned by list_messages and search_messages.",
    inputSchema: { id: z.string() },
    outputSchema: messageSchema.shape,
    annotations: readOnly
  }, toolHandler(ctx, registry, "fetch_message") as any);

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

  const dedicated: [string, string][] = [
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
