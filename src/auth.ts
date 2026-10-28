import { sha256 } from "@noble/hashes/sha2.js";
import { checkAuthor, parsePrincipal, type Principal } from "./core/principal.js";

/** Names the caller of a request, or returns null. Replace it with the agentic-identity `Auth` port when that ships. */
export type Authenticator = (request: Request) => Promise<Principal | null>;

/** The token setting is unusable. The message never holds a token. */
export class ConfigError extends Error {}

const digest = (text: string): Uint8Array => sha256(new TextEncoder().encode(text));

function same(a: Uint8Array, b: Uint8Array): boolean {
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/** Read `token=kind:name,token=kind:name`. Each token needs 32 or more characters. */
export function parseTokens(config: string | undefined): [Uint8Array, Principal][] {
  const entries: [Uint8Array, Principal][] = [];
  const seen = new Set<string>();
  for (const part of (config ?? "").split(",").filter((p) => p.trim() !== "")) {
    const cut = part.indexOf("=");
    const token = part.slice(0, cut).trim();
    if (cut < 0 || !/^[A-Za-z0-9._~+-]{32,}$/.test(token)) throw new ConfigError("a token needs 32 or more of A-Z a-z 0-9 . _ ~ + -");
    if (seen.has(token)) throw new ConfigError("two entries share a token");
    seen.add(token);
    try {
      entries.push([digest(token), checkAuthor(parsePrincipal(part.slice(cut + 1).trim()))]);
    } catch {
      throw new ConfigError("a token needs a principal as <kind>:<name>");
    }
  }
  return entries;
}

/** Bearer tokens. With no token configured, every request is refused. */
export function tokenAuth(tokens: [Uint8Array, Principal][]): Authenticator {
  return async (request) => {
    const given = /^bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (given === undefined) return null;
    const hash = digest(given);
    let found: Principal | null = null;
    for (const [expected, principal] of tokens) if (same(expected, hash)) found = principal;
    return found;
  };
}
