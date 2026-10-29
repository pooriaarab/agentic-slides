#!/usr/bin/env node
import { SlidesError, parsePrincipal } from "./core/principal.js";
import { isLiveServer } from "./live.js";
import { startMcp } from "./mcp.js";

const named = process.env.SLIDES_AUTHOR;
const server = process.env.SLIDES_LIVE_URL;
if (server !== undefined && (!isLiveServer(server) || !process.env.SLIDES_LIVE_TOKEN || named !== undefined)) {
  // A live server that is named but unusable never falls back to files. The token sets the author, so SLIDES_AUTHOR is refused.
  console.error("SLIDES_LIVE_URL needs an https:// address (http:// only for this machine) and SLIDES_LIVE_TOKEN needs a token. Do not set SLIDES_AUTHOR: the token sets who edits");
  process.exit(1);
}
startMcp({
  author: named ? parsePrincipal(named) : undefined,
  live: server === undefined ? undefined : { server, token: process.env.SLIDES_LIVE_TOKEN!, name: process.env.SLIDES_LIVE_NAME },
}).catch((error: unknown) => {
  console.error(error instanceof SlidesError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exit(1);
});
