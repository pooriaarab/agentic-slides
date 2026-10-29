import { sha256 } from "@noble/hashes/sha2.js";
import type { Role } from "agentic-identity";
import { checkAuthor, parsePrincipal, type Principal } from "./core/principal.js";

/** What a token may do. An editor reads and writes. A viewer only reads, over HTTP and in a live room. */
export type SlidesRole = Extract<Role, "editor" | "viewer">;

/** Who a request comes from, and what that caller may do. */
export interface Caller {
  author: Principal;
  role: SlidesRole;
}

/** Names the caller of a request, or returns null. It throws `NotGrantedError` for a caller that is known and holds no slides scope. */
export type Authenticator = (request: Request) => Promise<Caller | null>;

/** The credential is valid and its principal holds no `slides:read` or `slides:write` scope. The API answers 403. */
export class NotGrantedError extends Error {}

/** The token setting is unusable. The message never holds a token. */
export class ConfigError extends Error {}

const digest = (text: string): Uint8Array => sha256(new TextEncoder().encode(text));

function same(a: Uint8Array, b: Uint8Array): boolean {
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/** Read `token=kind:name,token=kind:name;viewer`. Each token needs 32 to 512 characters from A-Z a-z 0-9 _ -. The role is `editor` (the default) or `viewer`. */
export function parseTokens(config: string | undefined): [Uint8Array, Caller][] {
  const entries: [Uint8Array, Caller][] = [];
  const seen = new Set<string>();
  for (const part of (config ?? "").split(",").filter((p) => p.trim() !== "")) {
    const cut = part.indexOf("=");
    const token = part.slice(0, cut).trim();
    if (cut < 0 || !/^[A-Za-z0-9_-]{32,512}$/.test(token)) throw new ConfigError("a token needs 32 to 512 of A-Z a-z 0-9 _ -");
    if (seen.has(token)) throw new ConfigError("two entries share a token");
    seen.add(token);
    try {
      const value = part.slice(cut + 1).trim();
      const semi = value.lastIndexOf(";");
      const role = semi < 0 ? "editor" : value.slice(semi + 1);
      if (role !== "editor" && role !== "viewer") throw new ConfigError("a role is editor or viewer");
      entries.push([digest(token), { author: checkAuthor(parsePrincipal(semi < 0 ? value : value.slice(0, semi))), role }]);
    } catch {
      throw new ConfigError("a token needs a principal as <kind>:<name>, and a role of editor or viewer after a semicolon");
    }
  }
  return entries;
}

/** Bearer tokens. With no token configured, every request is refused. */
export function tokenAuth(tokens: [Uint8Array, Caller][]): Authenticator {
  return async (request) => {
    const given = /^bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (given === undefined) return null;
    const hash = digest(given);
    let found: Caller | null = null;
    for (const [expected, caller] of tokens) if (same(expected, hash)) found = caller;
    return found;
  };
}
