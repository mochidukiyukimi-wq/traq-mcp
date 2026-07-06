import assert from "node:assert/strict";
import { buildRegistry, fillPath, isBlockedEndpoint } from "./registry.js";

const registry = buildRegistry({
  paths: {
    "/channels/{channelId}/messages": { get: { operationId: "getChannelMessages", parameters: [{ name: "channelId", in: "path" }] } },
    "/oauth2/authorize": { get: { operationId: "authorize" } },
    "/users/me/tokens": { get: { operationId: "getTokens" } },
    "/clients/{clientId}": { get: { operationId: "getClient" } },
    "/messages": { post: { operationId: "postMessage" } }
  }
});

assert.equal(registry.has("/channels/{channelId}/messages"), true);
assert.equal(registry.has("/oauth2/authorize"), false);
assert.equal(registry.has("/users/me/tokens"), false);
assert.equal(registry.has("/clients/{clientId}"), false);
assert.equal(registry.has("/messages"), false);
assert.equal(isBlockedEndpoint("/oauth2/token"), true);
assert.equal(fillPath("/channels/{channelId}/messages", { channelId: "a b" }), "/channels/a%20b/messages");
console.log("selfcheck ok");
