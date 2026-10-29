# Changelog

This file lists the notable changes to this project, by version.

## 0.2.0 - 2026-10-29

### Breaking changes

- The Worker entry is now `src/live-worker.ts`. `wrangler.jsonc` adds the `SYNC_ROOM` Durable Object
  binding and its `v1` migration. Deploy with the new `wrangler.jsonc`. A Worker that lacks the
  binding cannot serve live rooms.
- `agentic-identity` moves from ^0.2.0 to ^0.3.0. A project that pins `agentic-identity` to 0.2
  must move to 0.3 to install this version.
- The exports of `agentic-slides` did not change. The new `agentic-slides/live` export is added.

### Added

- Live rooms. The Worker hosts one room for each deck (a Durable Object from `agentic-realtime`), so a person
  and an agent edit one deck at once. Routes: `GET /decks/:deck/ws`, `GET /me`, `GET /decks/:deck/state`, and
  `POST /decks/:deck/checkpoint`. A checkpoint checks author labels, elements, and size before it saves.
- Token roles: `token=kind:name;viewer`. A viewer reads and cannot write.
- A live client (`agentic-slides/live`), and `--live` for the CLI and `SLIDES_LIVE_URL` for the CLI and the MCP
  server. Both join a room with a token. The token sets the author.

### Changed

- The package depends on `agentic-realtime` ^0.1.0 for live rooms. `agentic-identity` is ^0.3.0.

## 0.1.0 - 2026-10-29

First release.

### Added

- Deck library. A deck is a Yjs document with ordered slides. Each slide has a layout,
  elements, and speaker notes. All positions use one 1280 by 720 space.
- Outline format and compiler. Add slides from an outline, or set one slide from an outline.
- Text-fit estimate. The deck refuses text that does not fit its box (`TEXT_OVERFLOW`).
- HTML render of a deck and a present page. The render escapes all text and loads no remote asset.
- PDF export without a browser. PDF export embeds the bundled fonts.
- CLI (`agentic-slides`): new, add, outline, edit, move, delete, render, and export.
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
