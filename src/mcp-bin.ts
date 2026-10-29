#!/usr/bin/env node
import { SlidesError, parsePrincipal } from "./core/principal.js";
import { startMcp } from "./mcp.js";

const named = process.env.SLIDES_AUTHOR;
const server = process.env.SLIDES_LIVE_URL;
if (server !== undefined && (!/^https?:\/\/[^/\s]+/.test(server) || !process.env.SLIDES_LIVE_TOKEN)) {
  // A live server that is named but unusable never falls back to files.
  console.error("SLIDES_LIVE_URL needs an http:// or https:// address, and SLIDES_LIVE_TOKEN needs a token");
  process.exit(1);
}
startMcp({
  author: named ? parsePrincipal(named) : undefined,
  live: server === undefined ? undefined : { server, token: process.env.SLIDES_LIVE_TOKEN!, name: process.env.SLIDES_LIVE_NAME },
}).catch((error: unknown) => {
  console.error(error instanceof SlidesError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exit(1);
});
