# Changelog

This file lists the notable changes to this project, by version.

## Unreleased

## 0.5.0 - 2026-10-29

### Breaking changes

These changes affect how you deploy the Worker. No HTTP API, SDK, CLI, or MCP call changes.

- Run `npm run build` before `wrangler deploy` or `wrangler dev`. Without `dist/ui`, Wrangler stops with an error
  that names `assets.directory`.
- When the Worker config serves `dist/ui`, `GET /` answers with the UI page, not with a JSON 404. A monitor that
  expects a 404 at `/` now gets the page.

### Added

- A web UI at `/` on the Worker, built on `agentic-design`: deck list, slide sorter, slide canvas, present
  mode, live presence, and an agent mark on slides that an agent edited. `npm run build` writes it to `dist/ui`.
- `GET /api/v1/slides/decks` and `client.listDecks()` list the decks, newest edit first, with the last editor of each. They page with a cursor. A new or edited deck is listed at once. A deck that nobody edits after you upgrade to 0.5.0 is not listed, but its data is not lost: edit it once to list it. `agentic-slides/client` also exports the `DeckSummary` and `SlideOutline` types.
- `npm run e2e`: Playwright tests of the UI against `wrangler dev`, an axe WCAG 2.2 AA check of each view
  in light and dark, and `npm run e2e:screenshots` for the screenshots in `docs/screenshots`.
- The room route accepts the token as the WebSocket subprotocol `bearer.<token>`, for browsers.

### Changed

- `wrangler.jsonc` serves the UI from `./dist/ui` as static assets. See "Breaking changes" for the build step.
- `npm run build` also bundles the UI. `prepack` runs it, so the npm package has `dist/ui`.
- The package ships the licenses of the UI fonts and of the code in the UI bundle, in `dist/ui/licenses`.
- `npm run ci:local` runs the browser tests too (`npm run e2e`). Run `npx playwright install chromium` once first.
- The CI workflow runs `npm run e2e` after `npm test`.

## 0.4.0 - 2026-10-29

### Added

- `agentic-slides/client` is a new subpath. `createClient({ baseUrl, token, fetch? })` returns a typed
  client for the HTTP API, with one method for each route. It uses only `fetch`, so it runs in browsers,
  Workers, and Node 22. A refused call throws `SlidesApiError` with the HTTP `status` and the API `code`.
  Each call takes an `AbortSignal`. The client never retries a call. The live room route stays with
  `LiveDeck` from `agentic-slides/live`.
- The README has an "SDK" section for the client. `llms.txt` lists it.

### Changed

- No other change since 0.3.0.

## 0.3.0 - 2026-10-29

### Changed

- This release has no code change. The 0.4.0 grant keys of `agentic-identity` are a breaking change for a
  host that shares decks. See the breaking changes of 0.2.0 for the steps: run `migrateGrants(store)`
  and call `deleteResource` when you delete a deck.
- The breaking changes of 0.2.0 now include these steps. They were not in the notes when 0.2.0 was
  released. Read them again, also the steps for an `unresolved` grant and for an erase error.
- New tests pin the kind and id grant keys, the erase of grants, and `migrateGrants`.

## 0.2.0 - 2026-10-29

### Breaking changes

- `agentic-identity` is ^0.4.0 in this release. A grant belongs to a kind and an id. A person and an agent
  with the same id hold separate roles. A grant that a host made under an old key is not used. This
  includes the owner role, so a deck shared through the old keys has no owner until you move the grants. There
  is no migration in this package. Before you serve requests, run `migrateGrants(store)` from
  `agentic-identity` on the store. It moves each old grant to the new key. It lists the grants that it
  cannot move in `unresolved`. A grant that is not moved is not used. This package makes no grant. Its
  roles come from `SLIDES_TOKENS`.
- This package has no command that deletes a deck. A host that shares decks must call `deleteResource`
  when it deletes one. After a store error, the host runs the call again. After `EraseRefusedError`,
  the host removes the children, or removes owners until no more than `MAX_OWNERS_ON_ERASE` stay.
- The Worker entry is now `src/live-worker.ts`. `wrangler.jsonc` adds the `SYNC_ROOM` Durable Object
  binding and its `v1` migration. Deploy with the new `wrangler.jsonc`. A Worker that lacks the
  binding cannot serve live rooms, and `POST /decks/:deck/checkpoint` fails with a server error.
- The token setting `SLIDES_TOKENS` reads the text after the last `;` as the role. The role must be
  `editor` or `viewer`. If one entry has a bad role, such as `human:a;b`, the Worker refuses every
  API request with a configuration error. `GET /health` still answers.
  An entry such as `human:ada;viewer` is no longer an editor named `ada;viewer`. It is a viewer
  named `ada`. An entry such as `human:ada;editor` is now named `ada`. Check the entries before you
  deploy.
- `SlidesErrorCode` has three new codes: `FORBIDDEN`, `INVALID_UPDATE`, and `LIVE_UNAVAILABLE`. A
  `switch` that must cover every code needs a case for each new code.

### Added

- Live rooms. The Worker hosts one room for each deck (a Durable Object from `agentic-realtime`), so a person
  and an agent edit one deck at once. Routes: `GET /decks/:deck/ws`, `GET /me`, `GET /decks/:deck/state`, and
  `POST /decks/:deck/checkpoint`. A checkpoint checks author labels, elements, and size before it saves.
- Token roles: `token=kind:name;viewer`. A viewer reads and cannot write.
- A live client (`agentic-slides/live`), and `--live` for the CLI and `SLIDES_LIVE_URL` for the CLI and the MCP
  server. Both join a room with a token. The token sets the author.

### Changed

- The root exports of `agentic-slides` stay the same. The `agentic-slides/live` export is new.
- The package depends on `agentic-realtime` ^0.2.0 for live rooms. This package does not call the methods
  `revoke`, `updateRole`, `roleFor`, `erase`, `exportHistory`, and `attribution` of the `Realtime` port yet.
  A live room cannot revoke a token or change its role in this release.
- `agentic-identity` moves from ^0.2.0 to ^0.4.0. See the breaking changes above.

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
