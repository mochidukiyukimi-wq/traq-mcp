import type { Config } from "./config.js";
import { decryptText, encryptText } from "./crypto.js";
import type { Store, TokenRow } from "./db.js";
import { fillPath, type Endpoint } from "./registry.js";

export type TraqContext = {
  config: Config;
  store: Store;
  userId: number;
  connectionId: number;
};

type OAuthTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

export async function exchangeCode(config: Config, code: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.traqClientId,
    client_secret: config.traqClientSecret,
    redirect_uri: config.traqRedirectUri,
    code
  });
  const response = await fetch(config.traqOAuthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`oauth_token_exchange_failed:${response.status}`);
  return response.json() as Promise<OAuthTokenResponse>;
}

export async function refreshAccessToken(config: Config, refreshToken: string): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.traqClientId,
    client_secret: config.traqClientSecret,
    refresh_token: refreshToken
  });
  const response = await fetch(config.traqOAuthTokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error("reauth_required");
  return response.json() as Promise<OAuthTokenResponse>;
}

export function hasReadScope(scope?: string): boolean {
  return (scope ?? "read").split(/\s+/).includes("read");
}

export function tokenRow(config: Config, userId: number, token: OAuthTokenResponse, previous?: TokenRow): TokenRow {
  const refreshToken = token.refresh_token ?? (previous ? decryptText(config.tokenEncryptionKey, previous.refresh_token_encrypted) : undefined);
  if (!refreshToken) throw new Error("oauth_refresh_token_missing");
  return {
    user_id: userId,
    access_token_encrypted: encryptText(config.tokenEncryptionKey, token.access_token),
    refresh_token_encrypted: encryptText(config.tokenEncryptionKey, refreshToken),
    expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    scope: token.scope ?? "read"
  };
}

async function accessToken(ctx: TraqContext): Promise<string> {
  const row = ctx.store.getTokens(ctx.userId);
  if (Date.parse(row.expires_at) > Date.now() + 60_000) {
    return decryptText(ctx.config.tokenEncryptionKey, row.access_token_encrypted);
  }
  const refreshed = await refreshAccessToken(ctx.config, decryptText(ctx.config.tokenEncryptionKey, row.refresh_token_encrypted));
  ctx.store.saveTokens(tokenRow(ctx.config, ctx.userId, refreshed, row));
  return refreshed.access_token;
}

export async function getMe(config: Config, accessToken: string): Promise<{ id: string; name: string; displayName?: string }> {
  const response = await fetch(`${config.traqApiBaseUrl}/users/me`, {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error(`traQ user fetch failed: ${response.status}`);
  return response.json() as Promise<{ id: string; name: string; displayName?: string }>;
}

export async function traqGet(
  ctx: TraqContext,
  endpoint: Endpoint,
  params: Record<string, string>,
  query: Record<string, string | number | boolean | undefined>
): Promise<{ status: number; body: unknown; resultCount?: number }> {
  const limit = query.limit;
  if (ctx.config.mcpHardMaxLimit !== undefined && limit !== undefined && Number(limit) > ctx.config.mcpHardMaxLimit) {
    return {
      status: 400,
      body: { error: "limit_too_large", message: "limit is larger than MCP_HARD_MAX_LIMIT", maxLimit: ctx.config.mcpHardMaxLimit }
    };
  }
  const url = new URL(`${ctx.config.traqApiBaseUrl}${fillPath(endpoint.path, params)}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { authorization: `Bearer ${await accessToken(ctx)}` } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (response.status === 401 || response.status === 403) {
    return { status: response.status, body: { error: "traq_api_error", status: response.status, message: `traQ API returned ${response.status}` } };
  }
  return { status: response.status, body, resultCount: Array.isArray(body) ? body.length : undefined };
}
