import assert from "node:assert/strict";
import { flattenChannels } from "./mcp.js";
import { buildRegistry, fillPath, isBlockedEndpoint } from "./registry.js";
import { hasReadScope, tokenRow } from "./traq.js";

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
assert.equal(hasReadScope("read"), true);
assert.equal(hasReadScope("openid read"), true);
assert.equal(hasReadScope("write"), false);
assert.deepEqual(flattenChannels([{ id: "1", name: "general" }, { id: "2", name: "random", parentId: "1" }]), [
  { id: "1", name: "general", parentId: undefined, path: "general" },
  { id: "2", name: "random", parentId: "1", path: "general/random" }
]);
assert.doesNotThrow(() => tokenRow({ tokenEncryptionKey: Buffer.alloc(32) } as any, 1, { access_token: "a" }));
console.log("selfcheck ok");
