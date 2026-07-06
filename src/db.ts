import { DatabaseSync } from "node:sqlite";
import { hashSecret, makeMcpKey } from "./crypto.js";

export type User = { id: number; traq_user_id: string; traq_name: string };
export type TokenRow = {
  user_id: number;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  expires_at: string;
  scope: string;
};
export type Connection = {
  id: number;
  user_id: number;
  key_hash: string;
  name: string | null;
  is_active: number;
  last_used_at: string | null;
};

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      create table if not exists users (
        id integer primary key autoincrement,
        traq_user_id text not null unique,
        traq_name text not null,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      );
      create table if not exists traq_oauth_tokens (
        user_id integer primary key references users(id),
        access_token_encrypted text not null,
        refresh_token_encrypted text not null,
        expires_at text not null,
        scope text not null,
        created_at text not null default current_timestamp,
        updated_at text not null default current_timestamp
      );
      create table if not exists mcp_connections (
        id integer primary key autoincrement,
        user_id integer not null references users(id),
        key_hash text not null unique,
        name text,
        is_active integer not null default 1,
        created_at text not null default current_timestamp,
        last_used_at text,
        revoked_at text
      );
      create table if not exists audit_logs (
        id integer primary key autoincrement,
        connection_id integer references mcp_connections(id),
        tool_name text not null,
        path text,
        status integer,
        result_count integer,
        created_at text not null default current_timestamp
      );
      create table if not exists web_sessions (
        id integer primary key autoincrement,
        user_id integer not null references users(id),
        session_hash text not null unique,
        created_at text not null default current_timestamp
      );
    `);
  }

  upsertUser(traqUserId: string, traqName: string): User {
    this.db.prepare(`
      insert into users (traq_user_id, traq_name) values (?, ?)
      on conflict(traq_user_id) do update set traq_name = excluded.traq_name, updated_at = current_timestamp
    `).run(traqUserId, traqName);
    return this.db.prepare("select * from users where traq_user_id = ?").get(traqUserId) as User;
  }

  saveTokens(row: TokenRow): void {
    this.db.prepare(`
      insert into traq_oauth_tokens (user_id, access_token_encrypted, refresh_token_encrypted, expires_at, scope)
      values (?, ?, ?, ?, ?)
      on conflict(user_id) do update set
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        expires_at = excluded.expires_at,
        scope = excluded.scope,
        updated_at = current_timestamp
    `).run(row.user_id, row.access_token_encrypted, row.refresh_token_encrypted, row.expires_at, row.scope);
  }

  getTokens(userId: number): TokenRow {
    return this.db.prepare("select * from traq_oauth_tokens where user_id = ?").get(userId) as TokenRow;
  }

  createConnection(userId: number, prefix: string): string {
    const key = makeMcpKey(prefix);
    this.db.prepare("insert into mcp_connections (user_id, key_hash, name) values (?, ?, ?)")
      .run(userId, hashSecret(key), "default");
    return key;
  }

  activeConnectionByKeyHash(keyHash: string): Connection | undefined {
    return this.db.prepare("select * from mcp_connections where key_hash = ? and is_active = 1").get(keyHash) as Connection | undefined;
  }

  latestConnection(userId: number): Connection | undefined {
    return this.db.prepare("select * from mcp_connections where user_id = ? order by id desc limit 1").get(userId) as Connection | undefined;
  }

  touchConnection(id: number): void {
    this.db.prepare("update mcp_connections set last_used_at = current_timestamp where id = ?").run(id);
  }

  revokeConnections(userId: number): void {
    this.db.prepare("update mcp_connections set is_active = 0, revoked_at = current_timestamp where user_id = ? and is_active = 1").run(userId);
  }

  regenerateConnection(userId: number, prefix: string): string {
    this.revokeConnections(userId);
    return this.createConnection(userId, prefix);
  }

  createWebSession(userId: number, session: string): void {
    this.db.prepare("insert into web_sessions (user_id, session_hash) values (?, ?)").run(userId, hashSecret(session));
  }

  userBySession(session: string): User | undefined {
    return this.db.prepare(`
      select users.* from users join web_sessions on web_sessions.user_id = users.id
      where web_sessions.session_hash = ?
    `).get(hashSecret(session)) as User | undefined;
  }

  logTool(connectionId: number, toolName: string, path: string | undefined, status?: number, resultCount?: number): void {
    this.db.prepare("insert into audit_logs (connection_id, tool_name, path, status, result_count) values (?, ?, ?, ?, ?)")
      .run(connectionId > 0 ? connectionId : null, toolName, path ?? null, status ?? null, resultCount ?? null);
  }
}
