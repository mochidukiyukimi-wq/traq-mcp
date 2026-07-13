export const structuredFilterNames = [
  "username",
  "userId",
  "channelPath",
  "channelId",
  "after",
  "before",
  "limit",
  "cursor",
  "order",
  "includeBots"
] as const;

export function chatGptTools() {
  const filterProperties = {
    username: { type: "string" },
    userId: { type: "string" },
    channelPath: { type: "string" },
    channelId: { type: "string" },
    after: { type: "string", format: "date-time" },
    before: { type: "string", format: "date-time" },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    cursor: { type: "string" },
    order: { type: "string", enum: ["asc", "desc"], default: "desc" },
    includeBots: { type: "boolean", default: false }
  };
  const user = {
    type: "object",
    properties: { id: { type: "string" }, username: { type: "string" }, displayName: { type: "string" }, isBot: { type: "boolean" } },
    required: ["id", "username"],
    additionalProperties: false
  };
  const channel = {
    type: "object",
    properties: { id: { type: "string" }, path: { type: "string" }, name: { type: "string" }, parentId: { type: "string" } },
    required: ["id", "path"],
    additionalProperties: false
  };
  const message = {
    type: "object",
    properties: {
      id: { type: "string" }, text: { type: "string" }, renderedText: { type: "string" }, user, channel,
      createdAt: { type: "string" }, updatedAt: { type: "string" }, parentMessageId: { type: "string" }, threadId: { type: "string" },
      url: { type: "string" }, attachments: { type: "array", items: { type: "object", additionalProperties: true } },
      stamps: { type: "array", items: {} }
    },
    required: ["id", "text", "user", "channel", "createdAt", "url", "attachments", "stamps"],
    additionalProperties: false
  };
  const appliedFilters = {
    type: "object",
    properties: { ...filterProperties },
    required: ["order", "includeBots"],
    additionalProperties: false
  };
  const page = {
    type: "object",
    properties: { messages: { type: "array", items: message }, nextCursor: { type: "string" }, appliedFilters },
    required: ["messages", "appliedFilters"],
    additionalProperties: false
  };
  const query = {
    type: "string",
    description: "Optional plain-text keyword query. Do not put from: or in: filters here."
  };

  return [
    {
      name: "search",
      description: "Compatibility search. Specify users, channels, periods, ordering, and bot inclusion with structured arguments; never put from: or in: filters inside query.",
      inputSchema: { type: "object", properties: { query, ...filterProperties }, additionalProperties: false },
      outputSchema: {
        type: "object",
        properties: {
          results: { type: "array", items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, url: { type: "string" }, userId: { type: "string" }, channelId: { type: "string" }, createdAt: { type: "string" } }, required: ["id", "title", "url", "userId", "channelId", "createdAt"], additionalProperties: false } },
          nextCursor: { type: "string" },
          appliedFilters
        },
        required: ["results", "appliedFilters"],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    {
      name: "fetch",
      description: "Compatibility fetch. Use fetch_message for the common normalized Message type.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      outputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, text: { type: "string" }, url: { type: "string" }, metadata: message }, required: ["id", "title", "text", "url", "metadata"], additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    {
      name: "resolve_user",
      description: "Resolve an exact traQ username to userId. Fails with user_not_found instead of running an unrelated search.",
      inputSchema: { type: "object", properties: { username: { type: "string" } }, required: ["username"], additionalProperties: false },
      outputSchema: user,
      annotations: { readOnlyHint: true }
    },
    {
      name: "resolve_channel",
      description: "Resolve an exact human-readable traQ channel path to channelId. Fails with channel_not_found on failure.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      outputSchema: channel,
      annotations: { readOnlyHint: true }
    },
    {
      name: "list_messages",
      description: "List traQ history. Specify user, channel, period and order as structured arguments. Every returned message is re-verified against appliedFilters.",
      inputSchema: { type: "object", properties: filterProperties, additionalProperties: false },
      outputSchema: page,
      annotations: { readOnlyHint: true }
    },
    {
      name: "search_messages",
      description: "Search message text with structured user, channel, period, order and bot filters. Never mix from: or in: syntax into query.",
      inputSchema: { type: "object", properties: { query, ...filterProperties }, additionalProperties: false },
      outputSchema: page,
      annotations: { readOnlyHint: true }
    },
    {
      name: "fetch_message",
      description: "Fetch one message using the same normalized Message type as list_messages and search_messages.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      outputSchema: message,
      annotations: { readOnlyHint: true }
    },
    {
      name: "list_channel_messages",
      description: "Legacy alias for list_messages. Prefer channelPath/channelId structured arguments.",
      inputSchema: { type: "object", properties: filterProperties, additionalProperties: false },
      outputSchema: page,
      annotations: { readOnlyHint: true }
    }
  ];
}
