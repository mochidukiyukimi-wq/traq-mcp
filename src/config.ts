import { createHash } from "node:crypto";

export type Config = {
  traqClientId: string;
  traqClientSecret: string;
  traqRedirectUri: string;
  traqApiBaseUrl: string;
  traqOAuthAuthorizeUrl: string;
  traqOAuthTokenUrl: string;
  traqOpenApiUrl: string;
  publicBaseUrl: string;
  databasePath: string;
  tokenEncryptionKey: Buffer;
  mcpKeyPrefix: string;
  mcpHardMaxLimit?: number;
  port: number;
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function encryptionKey(): Buffer {
  const raw = required("TOKEN_ENCRYPTION_KEY");
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  if (/^[A-Za-z0-9+/=]{44}$/.test(raw)) return Buffer.from(raw, "base64");
  return createHash("sha256").update(raw).digest();
}

function databasePath(): string {
  const url = process.env.DATABASE_URL ?? "file:./traq-mcp.sqlite";
  return url.startsWith("file:") ? url.slice(5) : url;
}

export function loadConfig(): Config {
  const hardLimit = process.env.MCP_HARD_MAX_LIMIT;
  return {
    traqClientId: required("TRAQ_CLIENT_ID"),
    traqClientSecret: required("TRAQ_CLIENT_SECRET"),
    traqRedirectUri: required("TRAQ_REDIRECT_URI"),
    traqApiBaseUrl: process.env.TRAQ_API_BASE_URL ?? "https://q.trap.jp/api/v3",
    traqOAuthAuthorizeUrl: process.env.TRAQ_OAUTH_AUTHORIZE_URL ?? "https://q.trap.jp/api/v3/oauth2/authorize",
    traqOAuthTokenUrl: process.env.TRAQ_OAUTH_TOKEN_URL ?? "https://q.trap.jp/api/v3/oauth2/token",
    traqOpenApiUrl: process.env.TRAQ_OPENAPI_URL ?? "https://raw.githubusercontent.com/traPtitech/traQ/master/docs/v3-api.yaml",
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    databasePath: databasePath(),
    tokenEncryptionKey: encryptionKey(),
    mcpKeyPrefix: process.env.MCP_KEY_PREFIX ?? "mcp_",
    mcpHardMaxLimit: hardLimit ? Number(hardLimit) : undefined,
    port: Number(process.env.PORT ?? "3000")
  };
}
