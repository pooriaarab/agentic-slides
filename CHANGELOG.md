# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 - 2026-10-29

First release.

### Added

- Deck library. A deck is a Yjs document with ordered slides. Each slide has a layout,
  elements, and speaker notes. All positions use one 1280 by 720 space.
- Outline format and compiler. Add slides from an outline, or set one slide from an outline.
- Text-fit estimate. Text that does not fit its box is reported as an issue.
- HTML render of a deck and a present page. All text is escaped. No remote asset is loaded.
- PDF export without a browser. Fonts are bundled and embedded.
- CLI (`agentic-slides`): create, add, outline, edit, move, delete, render, and export.
- MCP server (`agentic-slides-mcp`, or `agentic-slides mcp`) with the deck tools.
- HTTP API as a Cloudflare Worker (Hono) under `/api/v1/slides`. Decks live in D1, and
  images live in R2.
- Bearer tokens. Each token names the author of its edits. The default is closed.
- Shared `Store` and `Blobs` ports from `agentic-identity` 0.2, with file adapters for
  the CLI and the MCP server.
- Every edit keeps the author kind: `human`, `agent_of_human`, `agent_of_agent`, `agent`,
  or `user_token`.

### Not yet ready

- ODP export.
- PPTX export.
