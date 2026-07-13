import { createHash } from "node:crypto";

export type ApiQuery = Record<string, string | number | boolean | undefined>;
export type ApiResult = { status: number; body: unknown; resultCount?: number; headers?: Record<string, string> };
export type ReaderGet = (path: string, params: Record<string, string>, query: ApiQuery) => Promise<ApiResult>;

export type ResolvedUser = {
  id: string;
  username: string;
  displayName?: string;
  isBot?: boolean;
};

export type ResolvedChannel = {
  id: string;
  path: string;
  name?: string;
  parentId?: string;
};

export type ReaderMessage = {
  id: string;
  text: string;
  renderedText?: string;
  user: ResolvedUser;
  channel: ResolvedChannel;
  createdAt: string;
  updatedAt?: string;
  parentMessageId?: string;
  threadId?: string;
  url: string;
  attachments: Array<{ id: string; url: string }>;
  stamps: unknown[];
};

export type MessageFiltersInput = {
  channelId?: string;
  channelPath?: string;
  userId?: string;
  username?: string;
  after?: string;
  before?: string;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
  includeBots?: boolean;
};

export type SearchMessagesInput = MessageFiltersInput & { query?: string };

export type AppliedFilters = {
  channelId?: string;
  channelPath?: string;
  userId?: string;
  username?: string;
  after?: string;
  before?: string;
  order: "asc" | "desc";
  includeBots: boolean;
};

export type MessagePage = {
  messages: ReaderMessage[];
  nextCursor?: string;
  appliedFilters: AppliedFilters;
};

type RawUser = { id: string; name: string; displayName?: string; bot?: boolean };
type RawChannel = { id: string; name: string; parentId?: string | null };
type RawMessage = {
  id: string;
  userId: string;
  channelId: string;
  content: string;
  createdAt: string;
  updatedAt?: string;
  stamps?: unknown[];
  threadId?: string | null;
};

export class ReaderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }

  toJSON() {
    return { error: this.code, message: this.message, status: this.status, ...(this.details ? { details: this.details } : {}) };
  }
}

export class TraqReader {
  private users?: Map<string, ResolvedUser>;
  private channels?: Map<string, ResolvedChannel>;

  constructor(private readonly get: ReaderGet) {}

  async resolveUser(username: string): Promise<ResolvedUser> {
    const normalized = username.trim().replace(/^@/, "").toLowerCase();
    if (!normalized) throw new ReaderError("invalid_filter", "username is required", 400);
    const user = [...(await this.userMap()).values()].find(item => item.username.toLowerCase() === normalized);
    if (!user) throw new ReaderError("user_not_found", `traQ user '${username}' was not found`, 404, { username });
    return user;
  }

  async resolveChannel(path: string): Promise<ResolvedChannel> {
    const normalized = normalizeChannelPath(path);
    if (!normalized) throw new ReaderError("invalid_filter", "channel path is required", 400);
    const channel = [...(await this.channelMap()).values()].find(item => item.path.toLowerCase() === normalized);
    if (!channel) throw new ReaderError("channel_not_found", `traQ channel '${path}' was not found`, 404, { path });
    return channel;
  }

  async listMessages(input: MessageFiltersInput = {}): Promise<MessagePage> {
    return this.queryMessages(undefined, input);
  }

  async searchMessages(input: SearchMessagesInput = {}): Promise<MessagePage> {
    const query = input.query?.trim();
    if (query && /(^|\s)(from|in):\S+/i.test(query)) {
      throw new ReaderError(
        "structured_filters_required",
        "Specify username/userId and channelPath/channelId as structured arguments, not inside query",
        400
      );
    }
    return this.queryMessages(query, input);
  }

  async fetchMessage(id: string): Promise<ReaderMessage> {
    if (!id) throw new ReaderError("invalid_filter", "message id is required", 400);
    const result = await this.get("/messages/{messageId}", { messageId: id }, {});
    this.assertApiSuccess(result, "message", { id });
    return this.normalizeMessage(result.body as RawMessage);
  }

  private async queryMessages(query: string | undefined, input: MessageFiltersInput): Promise<MessagePage> {
    const { applied, limit } = await this.resolveFilters(input);
    const fingerprint = cursorFingerprint({ query: query ?? null, ...applied });
    let offset = decodeCursor(input.cursor, fingerprint);
    const messages: ReaderMessage[] = [];
    let totalHits = 0;

    while (messages.length < limit) {
      const pageLimit = Math.min(100, limit - messages.length);
      const result = await this.get("/messages", {}, {
        word: query || undefined,
        after: applied.after,
        before: applied.before,
        in: applied.channelId,
        from: applied.userId,
        bot: applied.includeBots ? undefined : false,
        limit: pageLimit,
        offset,
        sort: applied.order === "asc" ? "-createdAt" : "createdAt"
      });
      this.assertApiSuccess(result, "messages");
      const body = result.body as { totalHits?: number; hits?: RawMessage[] };
      if (!body || !Array.isArray(body.hits) || !Number.isFinite(body.totalHits)) {
        throw new ReaderError("invalid_api_response", "traQ API returned an invalid MessageSearchResult", 502);
      }
      const hits = body.hits;
      totalHits = Number(body.totalHits);
      if (hits.length === 0) break;

      const normalized = await Promise.all(hits.map(message => this.normalizeMessage(message)));
      this.verifyMessages(normalized, applied);
      messages.push(...normalized);
      offset += hits.length;
      if (hits.length < pageLimit) break;
    }

    messages.sort((a, b) => {
      const byDate = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      const ordered = byDate || a.id.localeCompare(b.id);
      return applied.order === "asc" ? ordered : -ordered;
    });

    return {
      messages,
      ...(offset < totalHits ? { nextCursor: encodeCursor(offset, fingerprint) } : {}),
      appliedFilters: applied
    };
  }

  private async resolveFilters(input: MessageFiltersInput): Promise<{ applied: AppliedFilters; limit: number }> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ReaderError("invalid_limit", "limit must be an integer between 1 and 200", 400, { limit });
    }
    const order = input.order ?? "desc";
    if (order !== "asc" && order !== "desc") throw new ReaderError("invalid_filter", "order must be asc or desc", 400);
    const after = normalizeDate(input.after, "after");
    const before = normalizeDate(input.before, "before");
    if (after && before && Date.parse(after) >= Date.parse(before)) {
      throw new ReaderError("invalid_filter", "after must be earlier than before", 400, { after, before });
    }

    const userByName = input.username ? await this.resolveUser(input.username) : undefined;
    const userById = input.userId ? await this.userById(input.userId) : undefined;
    if (userByName && userById && userByName.id !== userById.id) {
      throw new ReaderError("filter_conflict", "username and userId resolve to different users", 400);
    }
    const user = userByName ?? userById;

    const channelByPath = input.channelPath ? await this.resolveChannel(input.channelPath) : undefined;
    const channelById = input.channelId ? await this.channelById(input.channelId) : undefined;
    if (channelByPath && channelById && channelByPath.id !== channelById.id) {
      throw new ReaderError("filter_conflict", "channelPath and channelId resolve to different channels", 400);
    }
    const channel = channelByPath ?? channelById;

    return {
      limit,
      applied: {
        ...(channel ? { channelId: channel.id, channelPath: channel.path } : {}),
        ...(user ? { userId: user.id, username: user.username } : {}),
        ...(after ? { after } : {}),
        ...(before ? { before } : {}),
        order,
        includeBots: input.includeBots ?? false
      }
    };
  }

  private async normalizeMessage(raw: RawMessage): Promise<ReaderMessage> {
    if (!raw?.id || !raw.userId || !raw.channelId || !raw.createdAt || typeof raw.content !== "string") {
      throw new ReaderError("invalid_api_response", "traQ API returned an invalid Message", 502);
    }
    const user = await this.userById(raw.userId);
    const channel = await this.channelById(raw.channelId);
    const rendered = renderContent(raw.content, await this.userMap(), await this.channelMap());
    return {
      id: raw.id,
      text: rendered.text,
      renderedText: rendered.text,
      user,
      channel,
      createdAt: new Date(raw.createdAt).toISOString(),
      ...(raw.updatedAt ? { updatedAt: new Date(raw.updatedAt).toISOString() } : {}),
      ...(rendered.citations[0] ? { parentMessageId: rendered.citations[0] } : {}),
      ...(raw.threadId ? { threadId: raw.threadId } : {}),
      url: `https://q.trap.jp/messages/${encodeURIComponent(raw.id)}`,
      attachments: rendered.attachments.map(id => ({ id, url: `https://q.trap.jp/files/${encodeURIComponent(id)}` })),
      stamps: Array.isArray(raw.stamps) ? raw.stamps : []
    };
  }

  private verifyMessages(messages: ReaderMessage[], applied: AppliedFilters): void {
    for (const message of messages) {
      const violations: string[] = [];
      if (applied.channelId && message.channel.id !== applied.channelId) violations.push("channelId");
      if (applied.userId && message.user.id !== applied.userId) violations.push("userId");
      if (applied.after && Date.parse(message.createdAt) <= Date.parse(applied.after)) violations.push("after");
      if (applied.before && Date.parse(message.createdAt) >= Date.parse(applied.before)) violations.push("before");
      if (!applied.includeBots && message.user.isBot !== false) violations.push("includeBots");
      if (violations.length > 0) {
        throw new ReaderError(
          "filter_verification_failed",
          "traQ API returned a message outside the applied filters; no results were returned",
          502,
          { messageId: message.id, violations, appliedFilters: applied }
        );
      }
    }
  }

  private async userById(id: string): Promise<ResolvedUser> {
    const user = (await this.userMap()).get(id);
    if (!user) throw new ReaderError("user_not_found", `traQ user '${id}' was not found`, 404, { userId: id });
    return user;
  }

  private async channelById(id: string): Promise<ResolvedChannel> {
    const channel = (await this.channelMap()).get(id);
    if (!channel) throw new ReaderError("channel_not_found", `traQ channel '${id}' was not found or is not accessible`, 404, { channelId: id });
    return channel;
  }

  private async userMap(): Promise<Map<string, ResolvedUser>> {
    if (this.users) return this.users;
    const result = await this.get("/users", {}, { "include-suspended": true });
    this.assertApiSuccess(result, "users");
    if (!Array.isArray(result.body) || result.body.some(user => !user?.id || !user?.name || typeof user?.bot !== "boolean")) {
      throw new ReaderError("invalid_api_response", "traQ API returned an invalid user list", 502);
    }
    const users = result.body as RawUser[];
    this.users = new Map(users.map(user => [user.id, {
      id: user.id,
      username: user.name,
      ...(user.displayName ? { displayName: user.displayName } : {}),
      isBot: Boolean(user.bot)
    }]));
    return this.users;
  }

  private async channelMap(): Promise<Map<string, ResolvedChannel>> {
    if (this.channels) return this.channels;
    const result = await this.get("/channels", {}, { "include-dm": false });
    this.assertApiSuccess(result, "channels");
    const publicChannels = (result.body as any)?.public;
    if (!Array.isArray(publicChannels) || publicChannels.some(channel => !channel?.id || !channel?.name)) {
      throw new ReaderError("invalid_api_response", "traQ API returned an invalid channel list", 502);
    }
    const byId = new Map(publicChannels.map(channel => [channel.id, channel]));
    const pathOf = (channel: RawChannel, seen = new Set<string>()): string => {
      if (seen.has(channel.id)) throw new ReaderError("invalid_api_response", "channel hierarchy contains a cycle", 502);
      if (!channel.parentId) return channel.name;
      const parent = byId.get(channel.parentId);
      if (!parent) return channel.name;
      const next = new Set(seen).add(channel.id);
      return `${pathOf(parent, next)}/${channel.name}`;
    };
    this.channels = new Map(publicChannels.map(channel => [channel.id, {
      id: channel.id,
      path: pathOf(channel),
      name: channel.name,
      ...(channel.parentId ? { parentId: channel.parentId } : {})
    }]));
    return this.channels;
  }

  private assertApiSuccess(result: ApiResult, target: string, details?: Record<string, unknown>): void {
    if (result.status >= 200 && result.status < 300) return;
    if (result.status === 401) throw new ReaderError("reauth_required", "traQ OAuth authorization is no longer valid", 401);
    if (result.status === 403) throw new ReaderError("permission_denied", `traQ denied access to ${target}`, 403, details);
    if (result.status === 404) throw new ReaderError("not_found", `${target} was not found`, 404, details);
    throw new ReaderError("traq_api_error", `traQ API returned ${result.status} for ${target}`, result.status, details);
  }
}

function normalizeChannelPath(path: string): string {
  return path.trim().replace(/^#/, "").replace(/^\/+|\/+$/g, "").toLowerCase();
}

function normalizeDate(value: string | undefined, field: string): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new ReaderError("invalid_filter", `${field} must be an ISO 8601 date-time`, 400, { [field]: value });
  return new Date(time).toISOString();
}

function cursorFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 16);
}

function encodeCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ v: 1, offset, fingerprint })).toString("base64url");
}

function decodeCursor(cursor: string | undefined, fingerprint: string): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value?.v !== 1 || value?.fingerprint !== fingerprint || !Number.isInteger(value?.offset) || value.offset < 0 || value.offset > 9900) {
      throw new Error("invalid cursor");
    }
    return value.offset;
  } catch {
    throw new ReaderError("invalid_cursor", "cursor is invalid or does not match the requested filters", 400);
  }
}

export function renderContent(
  content: string,
  users: Map<string, ResolvedUser>,
  channels: Map<string, ResolvedChannel>
): { text: string; attachments: string[]; citations: string[] } {
  const attachments: string[] = [];
  const citations: string[] = [];
  let text = "";
  let cursor = 0;

  while (cursor < content.length) {
    const start = content.indexOf("!{", cursor);
    if (start < 0) {
      text += content.slice(cursor);
      break;
    }
    text += content.slice(cursor, start);
    const end = findJsonObjectEnd(content, start + 1);
    if (end < 0) {
      text += content.slice(start);
      break;
    }
    const source = content.slice(start + 1, end + 1);
    try {
      const embed = JSON.parse(source) as { type?: string; id?: string; raw?: string };
      if (!embed.type || !embed.id) throw new Error("not an embed");
      if (embed.type === "user") text += `@${users.get(embed.id)?.username ?? embed.raw?.replace(/^@/, "") ?? embed.id}`;
      else if (embed.type === "channel") text += `#${channels.get(embed.id)?.path ?? embed.raw?.replace(/^#/, "") ?? embed.id}`;
      else if (embed.type === "file") {
        attachments.push(embed.id);
        text += `[attachment:${embed.id}]`;
      } else if (embed.type === "message") {
        citations.push(embed.id);
        text += `[message:${embed.id}]`;
      } else text += embed.raw ?? `[${embed.type}:${embed.id}]`;
      cursor = end + 1;
    } catch {
      text += content.slice(start, end + 1);
      cursor = end + 1;
    }
  }

  return { text, attachments: [...new Set(attachments)], citations: [...new Set(citations)] };
}

function findJsonObjectEnd(source: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}
