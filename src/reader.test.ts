import assert from "node:assert/strict";
import test from "node:test";
import { ReaderError, TraqReader, type ApiQuery, type ApiResult, type ReaderGet, type ReaderMessage } from "./reader.js";

const users = [
  { id: "u-helgev", name: "helgev", displayName: "Helgev", bot: false },
  { id: "u-other", name: "other", displayName: "Other", bot: false },
  { id: "u-bot", name: "notify_bot", displayName: "Notify Bot", bot: true }
];

const channels = [
  { id: "c-times", name: "times", parentId: null },
  { id: "c-22", name: "22", parentId: "c-times" },
  { id: "c-helgev", name: "helgev", parentId: "c-22" },
  { id: "c-other", name: "other", parentId: null }
];

function rawMessage(index: number, overrides: Record<string, unknown> = {}) {
  const createdAt = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  return {
    id: `m-${String(index).padStart(4, "0")}`,
    userId: "u-helgev",
    channelId: "c-helgev",
    content: `message ${index}`,
    createdAt,
    updatedAt: createdAt,
    stamps: [],
    threadId: null,
    ...overrides
  };
}

type FakeOptions = {
  messages?: ReturnType<typeof rawMessage>[];
  ignoreChannelFilter?: boolean;
  ignoreUserFilter?: boolean;
  errorPath?: string;
  errorStatus?: number;
};

function fakeGet(options: FakeOptions = {}): ReaderGet {
  const source = options.messages ?? [rawMessage(1), rawMessage(2), rawMessage(3)];
  return async (path, params, query): Promise<ApiResult> => {
    if (path === options.errorPath) return { status: options.errorStatus ?? 500, body: { error: "forced" }, headers: {} };
    if (path === "/users") return { status: 200, body: users, headers: {} };
    if (path === "/channels") return { status: 200, body: { public: channels }, headers: {} };
    if (path === "/channels/{channelId}/messages") {
      let hits = [...source];
      if (!options.ignoreChannelFilter) hits = hits.filter(message => message.channelId === params.channelId);
      if (query.since) hits = hits.filter(message => Date.parse(String(message.createdAt)) > Date.parse(String(query.since)));
      if (query.until) hits = hits.filter(message => Date.parse(String(message.createdAt)) < Date.parse(String(query.until)));
      hits.sort((a, b) => (query.order === "asc" ? 1 : -1) * (Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt))));
      const offset = Number(query.offset ?? 0);
      const limit = Number(query.limit ?? 200);
      const page = hits.slice(offset, offset + limit);
      return { status: 200, body: page, headers: { "x-traq-more": String(offset + page.length < hits.length) } };
    }
    if (path === "/messages/{messageId}") {
      const found = source.find(message => message.id === params.messageId);
      return found ? { status: 200, body: found, headers: {} } : { status: 404, body: null, headers: {} };
    }
    if (path !== "/messages") return { status: 404, body: null, headers: {} };

    let hits = [...source];
    if (query.word) hits = hits.filter(message => String(message.content).includes(String(query.word)));
    if (query.in && !options.ignoreChannelFilter) hits = hits.filter(message => message.channelId === query.in);
    if (query.from && !options.ignoreUserFilter) hits = hits.filter(message => message.userId === query.from);
    if (query.bot === false) {
      const botIds = new Set(users.filter(user => user.bot).map(user => user.id));
      hits = hits.filter(message => !botIds.has(String(message.userId)));
    }
    if (query.after) hits = hits.filter(message => Date.parse(String(message.createdAt)) > Date.parse(String(query.after)));
    if (query.before) hits = hits.filter(message => Date.parse(String(message.createdAt)) < Date.parse(String(query.before)));
    hits.sort((a, b) => {
      const delta = Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt));
      return query.sort === "-createdAt" ? delta : -delta;
    });
    const totalHits = hits.length;
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 100);
    return { status: 200, body: { totalHits, hits: hits.slice(offset, offset + limit) }, headers: {} };
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    assert.fail("expected ReaderError");
  } catch (error) {
    assert.ok(error instanceof ReaderError);
    return error.code;
  }
}

function assertMatches(page: { messages: ReaderMessage[] }, channelId?: string, userId?: string) {
  for (const message of page.messages) {
    if (channelId) assert.equal(message.channel.id, channelId);
    if (userId) assert.equal(message.user.id, userId);
  }
}

test("1 channelPath returns no messages from another channel", async () => {
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1), rawMessage(2, { channelId: "c-other" })] }));
  const page = await reader.listMessages({ channelPath: "times/22/helgev" });
  assertMatches(page, "c-helgev");
});

test("2 username returns only that username", async () => {
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1), rawMessage(2, { userId: "u-other" })] }));
  const page = await reader.listMessages({ username: "helgev" });
  assert.ok(page.messages.every(message => message.user.username === "helgev"));
});

test("3 channelPath and username are both applied", async () => {
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1), rawMessage(2, { userId: "u-other" }), rawMessage(3, { channelId: "c-other" })] }));
  const page = await reader.listMessages({ channelPath: "times/22/helgev", username: "helgev" });
  assertMatches(page, "c-helgev", "u-helgev");
});

test("4 messages at or before after are excluded", async () => {
  const after = rawMessage(2).createdAt;
  const page = await new TraqReader(fakeGet()).listMessages({ after });
  assert.ok(page.messages.every(message => Date.parse(message.createdAt) > Date.parse(after)));
});

test("5 messages at or after before are excluded", async () => {
  const before = rawMessage(3).createdAt;
  const page = await new TraqReader(fakeGet()).listMessages({ before });
  assert.ok(page.messages.every(message => Date.parse(message.createdAt) < Date.parse(before)));
});

test("6 asc returns createdAt ascending", async () => {
  const page = await new TraqReader(fakeGet()).listMessages({ order: "asc" });
  assert.deepEqual(page.messages.map(message => message.id), ["m-0001", "m-0002", "m-0003"]);
});

test("7 desc returns createdAt descending", async () => {
  const page = await new TraqReader(fakeGet()).listMessages({ order: "desc" });
  assert.deepEqual(page.messages.map(message => message.id), ["m-0003", "m-0002", "m-0001"]);
});

test("8 cursor retrieves more than 200 messages to the end", async () => {
  const reader = new TraqReader(fakeGet({ messages: Array.from({ length: 450 }, (_, index) => rawMessage(index)) }));
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await reader.listMessages({ channelPath: "times/22/helgev", limit: 200, cursor, order: "asc" });
    ids.push(...page.messages.map(message => message.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 450);
  assert.equal(new Set(ids).size, 450);
});

test("9 nonexistent username returns user_not_found", async () => {
  assert.equal(await errorCode(new TraqReader(fakeGet()).listMessages({ username: "missing" })), "user_not_found");
});

test("10 nonexistent channelPath returns channel_not_found", async () => {
  assert.equal(await errorCode(new TraqReader(fakeGet()).listMessages({ channelPath: "missing/path" })), "channel_not_found");
});

test("11 embeds are rendered as human-readable text", async () => {
  const content = [
    'hello !{"type":"user","raw":"@old","id":"u-helgev"}',
    '!{"type":"channel","raw":"#old","id":"c-helgev"}',
    '!{"type":"file","raw":"file","id":"file-1"}',
    '!{"type":"message","raw":"message","id":"parent-1"}'
  ].join(" ");
  const message = await new TraqReader(fakeGet({ messages: [rawMessage(1, { content })] })).fetchMessage("m-0001");
  assert.equal(message.text, "hello @helgev #times/22/helgev [attachment:file-1] [message:parent-1]");
  assert.equal(message.text.includes('!{"type"'), false);
  assert.deepEqual(message.attachments, [{ id: "file-1", url: "https://q.trap.jp/files/file-1" }]);
  assert.equal(message.parentMessageId, "parent-1");
});

test("12 includeBots=false excludes bot messages", async () => {
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1), rawMessage(2, { userId: "u-bot" })] }));
  const page = await reader.listMessages({ includeBots: false });
  assert.ok(page.messages.every(message => message.user.isBot === false));
});

test("13 appliedFilters match every returned message", async () => {
  const page = await new TraqReader(fakeGet()).listMessages({ channelPath: "times/22/helgev", username: "helgev", includeBots: false });
  assertMatches(page, page.appliedFilters.channelId, page.appliedFilters.userId);
  assert.equal(page.appliedFilters.channelPath, "times/22/helgev");
  assert.equal(page.appliedFilters.username, "helgev");
});

test("14 search, list and fetch use the same Message shape", async () => {
  const reader = new TraqReader(fakeGet());
  const listed = (await reader.listMessages({ limit: 1 })).messages[0];
  const searched = (await reader.searchMessages({ query: "message", limit: 1 })).messages[0];
  const fetched = await reader.fetchMessage(listed.id);
  assert.deepEqual(Object.keys(searched).sort(), Object.keys(listed).sort());
  assert.deepEqual(Object.keys(fetched).sort(), Object.keys(listed).sort());
});

test("15 API channel filter failure is rejected", async () => {
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1, { channelId: "c-other" })], ignoreChannelFilter: true }));
  assert.equal(await errorCode(reader.listMessages({ channelId: "c-helgev" })), "filter_verification_failed");
});

test("16 API user filter failure is rejected", async () => {
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1, { userId: "u-other" })], ignoreUserFilter: true }));
  assert.equal(await errorCode(reader.searchMessages({ userId: "u-helgev" })), "filter_verification_failed");
});

test("17 empty and long content do not depend on title truncation", async () => {
  const long = "x".repeat(20_000);
  const reader = new TraqReader(fakeGet({ messages: [rawMessage(1, { content: "" }), rawMessage(2, { content: long })] }));
  const empty = await reader.fetchMessage("m-0001");
  const full = await reader.fetchMessage("m-0002");
  assert.equal(empty.text, "");
  assert.equal(full.text.length, long.length);
  assert.equal("title" in empty, false);
});

test("18 API error, permission denied and not found are distinct", async () => {
  assert.equal(await errorCode(new TraqReader(fakeGet({ errorPath: "/messages", errorStatus: 500 })).listMessages()), "traq_api_error");
  assert.equal(await errorCode(new TraqReader(fakeGet({ errorPath: "/messages", errorStatus: 403 })).listMessages()), "permission_denied");
  assert.equal(await errorCode(new TraqReader(fakeGet()).fetchMessage("missing")), "not_found");
});

test("free-text from: and in: syntax is rejected", async () => {
  const reader = new TraqReader(fakeGet());
  assert.equal(await errorCode(reader.searchMessages({ query: "from:helgev hello" })), "structured_filters_required");
  assert.equal(await errorCode(reader.searchMessages({ query: "in:times/22/helgev hello" })), "structured_filters_required");
});
