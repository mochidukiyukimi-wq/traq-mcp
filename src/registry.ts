export type Endpoint = {
  method: "GET";
  path: string;
  operationId?: string;
  summary?: string;
  tags: string[];
  parameters: unknown[];
  responses?: unknown;
};

const blockedTags = new Set(["oauth2", "oauth", "client", "token"]);

export function isBlockedEndpoint(path: string, op: { tags?: string[]; operationId?: string; summary?: string } = {}): boolean {
  const lowerPath = path.toLowerCase();
  if (lowerPath.includes("/oauth2")) return true;
  if (lowerPath === "/clients" || lowerPath === "/clients/{clientid}") return true;
  if (lowerPath === "/users/me/tokens" || lowerPath.startsWith("/users/me/tokens/")) return true;
  if ((op.tags ?? []).some(tag => blockedTags.has(tag.toLowerCase()))) return true;
  const text = `${op.operationId ?? ""} ${op.summary ?? ""}`.toLowerCase();
  return /\boauth2?\b/.test(text) || /\btoken(s)?\b/.test(text) || /\boauth client\b/.test(text);
}

export function buildRegistry(openapi: any): Map<string, Endpoint> {
  const endpoints = new Map<string, Endpoint>();
  for (const [path, methods] of Object.entries(openapi.paths ?? {})) {
    const get = (methods as any).get;
    if (!get || isBlockedEndpoint(path, get)) continue;
    endpoints.set(path, {
      method: "GET",
      path,
      operationId: get.operationId,
      summary: get.summary,
      tags: get.tags ?? [],
      parameters: [...((methods as any).parameters ?? []), ...(get.parameters ?? [])],
      responses: get.responses
    });
  }
  return endpoints;
}

export async function loadRegistry(openApiUrl: string): Promise<Map<string, Endpoint>> {
  const response = await fetch(openApiUrl);
  if (!response.ok) throw new Error(`failed to load OpenAPI schema: ${response.status}`);
  const text = await response.text();
  return buildRegistry(text.trimStart().startsWith("{") ? JSON.parse(text) : parse(text));
}

export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, key) => {
    const value = params[key];
    if (!value) throw new Error(`missing path parameter: ${key}`);
    return encodeURIComponent(value);
  });
}

export function publicEndpoint(endpoint: Endpoint) {
  return {
    method: endpoint.method,
    path: endpoint.path,
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    tags: endpoint.tags,
    parameters: endpoint.parameters
  };
}
import { parse } from "yaml";
