#!/usr/bin/env node
import { VERSION } from "./version.js";

const HELP = `agentic-slides-mcp ${VERSION}
Usage: agentic-slides-mcp [mcp] [--help | --version]

Runs the MCP server on stdio. An MCP client starts it.
`;

// Loaded only when serving, so --help and --version never pay for the server's imports.
async function serve(): Promise<void> {
  const { SlidesError, parsePrincipal } = await import("./core/principal.js");
  const { isLiveServer } = await import("./live.js");
  const { startMcp } = await import("./mcp.js");

  const named = process.env.SLIDES_AUTHOR;
  const server = process.env.SLIDES_LIVE_URL;
  if (server !== undefined && (!isLiveServer(server) || !process.env.SLIDES_LIVE_TOKEN || named !== undefined)) {
    // A live server that is named but unusable never falls back to files. The token sets the author, so SLIDES_AUTHOR is refused.
    console.error("SLIDES_LIVE_URL needs an https:// address (http:// only for this machine) and SLIDES_LIVE_TOKEN needs a token. Do not set SLIDES_AUTHOR: the token sets who edits");
    process.exit(1);
  }
  await startMcp({
    author: named ? parsePrincipal(named) : undefined,
    live: server === undefined ? undefined : { server, token: process.env.SLIDES_LIVE_TOKEN!, name: process.env.SLIDES_LIVE_NAME },
  }).catch((error: unknown) => {
    console.error(error instanceof SlidesError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

// The `mcp` word may come first, as the package CLI takes it: `agentic-slides-mcp mcp --help`.
const argv = process.argv.slice(2);
const args = argv[0] === "mcp" ? argv.slice(1) : argv;
const has = (...names: string[]) => args.some((a) => names.includes(a));
if (has("--version", "-V")) {
  process.stdout.write(`${VERSION}\n`);
} else if (has("--help", "-h")) {
  process.stdout.write(HELP);
} else {
  serve().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
