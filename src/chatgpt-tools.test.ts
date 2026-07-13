import assert from "node:assert/strict";
import test from "node:test";
import { chatGptTools, structuredFilterNames } from "./chatgpt-tools.js";

function tool(name: string): any {
  const found = chatGptTools().find(candidate => candidate.name === name);
  assert.ok(found, `missing ${name} tool`);
  return found;
}

function assertStructuredFilters(name: string) {
  const properties = tool(name).inputSchema.properties;
  for (const property of structuredFilterNames) assert.ok(properties[property], `${name} is missing ${property}`);
}

test("tools/list search exposes every structured filter", () => {
  const search = tool("search");
  assertStructuredFilters("search");
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(search.inputSchema.properties.query.type, "string");
  assert.match(search.inputSchema.properties.query.description, /Do not put from: or in:/);
  assert.ok(!search.inputSchema.required?.includes("query"));
});

test("tools/list exposes dedicated structured message tools", () => {
  assertStructuredFilters("list_messages");
  assertStructuredFilters("search_messages");
  assert.ok(tool("search_messages").inputSchema.properties.query);
});

test("search filter bounds and defaults remain stable", () => {
  const properties = tool("search").inputSchema.properties;
  assert.deepEqual(properties.limit, { type: "integer", minimum: 1, maximum: 200, default: 50 });
  assert.deepEqual(properties.order, { type: "string", enum: ["asc", "desc"], default: "desc" });
  assert.deepEqual(properties.includeBots, { type: "boolean", default: false });
  assert.equal(properties.after.format, "date-time");
  assert.equal(properties.before.format, "date-time");
});
