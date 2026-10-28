#!/usr/bin/env node
import { SlidesError, parsePrincipal } from "./core/principal.js";
import { startMcp } from "./mcp.js";

const named = process.env.SLIDES_AUTHOR;
startMcp({ author: named ? parsePrincipal(named) : undefined }).catch((error: unknown) => {
  console.error(error instanceof SlidesError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
  process.exit(1);
});
