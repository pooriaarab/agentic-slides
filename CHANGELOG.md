# Changelog

This file lists the notable changes to this project, by version.

## 0.13.3 - 2026-10-29

### Changed

- `agentic-design` is now 0.8.x. The range moves from `^0.5.0` to `^0.8.0`. The range did not accept 0.8.0. A project that uses agentic-design 0.8 with agentic-slides could not install one copy of `agentic-design` for both. At release time, 0.8.0 was the newest `agentic-design` on npm.
- The npm `overrides` entry for `agentic-design` is removed. Version 0.8.0 asks for `zod` `^4.6.7` itself, so the override is not needed.
- The build, the typecheck, the unit and render tests, and the end-to-end tests pass on `agentic-design` 0.8.0. The UI code and the render code did not need a change.

## 0.13.2 - 2026-10-29

### Fixed

- `agentic-slides-mcp mcp --help`, `-h`, `--version` and `-V` print the usage or the version and exit 0. Before, the bin read only its first argument, so the `mcp` word started the MCP server and it waited on stdin.
- After the `mcp` word, the bin reads `--help`, `-h`, `--version` and `-V` anywhere in the arguments, as the package CLI does. When both help and version are given, `--help` wins. The usage line shows the optional `mcp` word. Without the `mcp` word, the bin reads only its first argument, as before.

## 0.13.1 - 2026-10-29

### Changed

- `agentic-identity` is now 0.9.x. The range moves from `^0.7.0` to `^0.9.0`.
- `agentic-formats` is now 0.4.x. The range moves from `^0.3.0` to `^0.4.2`.
- `agentic-realtime` is now 0.4.x. The range moves from `^0.4.0` to `^0.4.4`. It uses `agentic-identity` 0.9, the same copy as this package, so the install has one copy of the id rule.
- A live room principal id is `<kind>.<name>`, for example `human.ada`. It was `<kind>:<name>`. `agentic-realtime` 0.4.2 takes only ids of the `agentic-identity` rule, and that rule has no colon. The checkpoint label check still reads the `<kind>:<name>` key, so a label keeps its meaning.
- A live room refuses a token whose room id is longer than 128 characters. Its `/ws` call answers 403 `FORBIDDEN`. The room id is the kind, a dot, and the name. So the longest name is 122 characters for `human` and `agent`, 117 for `user_token`, and 113 for `agent_of_human` and `agent_of_agent`. Such a token still reads and writes the deck over HTTP.

### Fixed

- With `agentic-realtime` 0.4.2 or later, a connect to a live room, a grant, a revoke, or an invite on a live deck no longer answers 500 `INTERNAL`. The room refused the colon ids that the slides code sent. A revoke or a role change now skips an id that the room would refuse, so it cannot stop half way. An install that pins `agentic-realtime` 0.4.0 or 0.4.1 has no id check, so this error did not occur there.
- A grant, a revoke, or a role change on a live deck calls the room for every id of the subject, even when the room fails one of the calls. The route then answers with the first failure.

### Upgrade

- A ban or a role cap that an earlier version stored under `<kind>:<name>` does not apply to the `<kind>.<name>` id. The old entries stay in the room storage. They count toward the room limit on caps and bans, and the Worker cannot clear them. A revoked grant already stops a new connect, because the deck routes check the role first. The room ban is a second layer. After you deploy, revoke again each person or agent, so the room also holds a ban under the new id.
- Cloudflare restarts every Durable Object on a deploy, and that disconnects its WebSockets. So a live client reconnects after the deploy, and its new socket has the new id. A revoke or a lower role with the new id reaches every socket from then on.

## 0.13.0 - 2026-10-29

### Added

- `agentic-slides/account` is the account export and erase plug-in. A host calls `exportAccount` and `eraseAccount` for one subject, and it never reads the storage layout. An erase removes the decks of a sole owner and the other roles of the subject. It replaces the subject as author with the fixed name `erased` and keeps the kind, so a record that an agent made stays machine-made.
- With the `live` dependency, an erase clears the live room of each deck that it deletes or changes.

## 0.12.0 - 2026-10-29

### Changed

- Without `host`, `mount` throws a `TypeError` if the `client` or the `docId` is missing. Before, the editor failed later.

### Added

- Host document mode for `agentic-slides/ui`. Give `mount` (or `SlidesEditor`) a `host` with your own Yjs document, and the editor reads and writes that document. It makes no HTTP call, and it does not poll: it reads again at each change of the document. Without `host`, the editor works as before, with a `client` and a `docId`.
- `host.awareness` (the shape of a `y-protocols` awareness) shows the peers of your room and announces this person or agent. `host.putImage` stores a picture and gives back its `blob:sha256-<hex>` reference. Without it, the editor adds no image slide.
- With `host`, a `client` or a `presence` option, a document from another copy of Yjs, or a bad `awareness` or `putImage` throws a `TypeError` before anything renders.
- Each host edit carries the kind of the principal, so an agent edit shows the agent mark.
- The editor shows a deck only if it passes the checks of the service, and it writes nothing to a document that does not. It does not check the author labels that peers write.
- With `host`, Present is off until you give `onPresent`. `docId` is optional with `host`.

## 0.11.0 - 2026-10-29

### Changed

- The deck page and the present page take their colors, spacing, radius, and type size from `agentic-design` tokens. Each page inlines the `--agd-*` values it uses, in light and in dark, so the exported file is self-contained and loads nothing from the network. The slide keeps the deck theme. The look is the calm look of `agentic-design` 0.5, and the present page follows the system theme.
- `agentic-design` is now 0.5.x. The token names do not change.

## 0.10.0 - 2026-10-29

### Breaking changes

- BREAKING: design class prefix is now agd-. Design classes use `agd-`, and design custom properties use `--agd-*`, in the web UI and in the HTML and present-mode pages that the render code writes. The old prefix is gone, with no alias. Ad blockers hide the old names, so a block rule could remove a button or a toast. A stylesheet or test that targets an old name must change. `agentic-design` is now 0.4.x, the release that ships the `agd-` names.
- The Worker signs requests in with agentic-identity credentials by default. The scope `slides:write` makes an editor, `slides:read` a viewer, and a valid credential with neither gets 403. `SLIDES_TOKENS` is now a dev fallback. It needs `SLIDES_UNSAFE_STATIC_TOKENS=1`. A Worker that sets `SLIDES_TOKENS` without the switch answers every API call with 500 `MISCONFIGURED`. Set the switch in dev, or issue identity credentials.
- zod 4 words some validation messages differently, and it is stricter with some numbers (for example, `Infinity`). A 400 response can carry other `issues[].message` text. A client that matches on message text should match on the error code.

### Fixed

- zod moves to 4.6.7 to fix GHSA-mrhx-c7xc-m3w5, a high advisory (memory exhaustion when validating oversized constrained collections). The direct dependency moves from `^3.25.0` to `^4.6.7`. An npm `overrides` entry moves `agentic-design` and `agentic-formats` to zod 4.6.7 in this repo's install and build. npm ignores `overrides` in a published package, so an install of this package still gets zod 3 under those two packages until they accept zod 4. The `@modelcontextprotocol/sdk` floor moves from `^1.12.0` to `^1.23.0`, because earlier SDK releases depend on zod 3.

## 0.9.0 - 2026-10-29

Read the breaking changes before you upgrade or deploy.

### Breaking changes

- The Worker refuses a token name that holds no role. A token name in `SLIDES_TOKENS` must use only A-Z a-z 0-9 _ -. An `agent` token name cannot start with a delegated kind and an underscore. The subject of the token (see below) must have 1 to 128 characters. For a delegated kind, the kind and the underscore count. A setting with another name, such as `human:ada.lovelace`, makes every `/api/v1/slides` call that needs a bearer token answer 500 `MISCONFIGURED`. `/health` still answers, and the shared link routes still answer a request with no bearer token. Rename the token before you deploy. Local decks and the library still accept the wider principal names.
- The Worker checks roles on each deck. A deck made through the Worker has an owner. Only its roles decide who reads or changes it, so an editor token no longer changes every deck. A caller with no role gets 404 for that deck, and a role that is too low gets 403. A deck made before this release has no owner and keeps the token check. `GET /decks` lists only the decks that the caller holds a role on, and the decks with no owner. A client that lists every deck sees fewer decks. A page can hold fewer decks than `limit`, or none, and still have a `nextCursor`. A client must page until `nextCursor` is absent.

### Added

- Sharing. A deck made through the Worker has an owner. The owner gives the roles owner, editor, commenter, and viewer to people and agents, invites by email or handle, and makes share links. HTTP routes: `GET /decks/:deck/access`, `POST` and `DELETE /decks/:deck/grants`, `POST /decks/:deck/invites`, `POST /invites/accept`, `POST /decks/:deck/links`, `DELETE /decks/:deck/links/:link`, `GET /shared/:deck`, and `GET /shared/:deck/render`. Only an invite by handle can be accepted over HTTP, and only by an agent token. A link reads the outline and the page, and never writes.
- A revoke closes the live room sockets of the person or agent that lost the role. A grant of a lower role makes open sockets read only at once.
- Client calls in `agentic-slides/client`: `access`, `grant`, `revoke`, `invite`, `acceptInvite`, `createShareLink`, `revokeShareLink`, and `readShared`. CLI commands `access`, `grant`, `revoke`, `invite`, `accept-invite`, `share-link`, and `revoke-link`, which need `--live`. MCP tools `list_access`, `grant_access`, `revoke_access`, `invite`, `accept_invite`, `create_share_link`, and `revoke_share_link`, in a live setting.
- `GET /me` also returns the `subject` that the token holds roles as.
- The error code `INVALID_SHARE` is added to `SlidesErrorCode`. HTTP answers it with 400. A TypeScript `switch` on that union needs a new case.

## 0.8.0 - 2026-10-29

This release has no breaking change. Its HTTP routes, SDK calls, and CLI and MCP commands that existed before still work the same way.

### Added

- `list_decks` MCP tool and `list` CLI command. Each returns one page of decks, newest edit first, with the last editor of each. Both take `limit` (1 to 200) and `cursor`. The live service has `list` too. It checks the id, title, save time, and machine-made flag of each item, and it refuses a list with an item that fails the check.
- `delete_deck` MCP tool, `delete-deck` CLI command, `DELETE /api/v1/decks/:deck` route, and `deleteDeck` in `agentic-slides/client` and the live service. The delete removes the deck and its list entry in one transaction. Images stay in the store, because other decks can use them.
- The HTTP route clears the live room of a deck before it deletes the deck, so a new deck with the same id does not read the old state. A host that calls the service directly must clear the room itself. A host that shares decks must also remove the sharing grants.
- `agentic-slides/formats` maps a deck to and from ODP and PPTX: `deckToOdp`, `deckToPptx`, `outlineFromOdp`, and `outlineFromPptx`. It also exports `toFormatsDeck`, `outlineFromFormatsDeck`, and the types `ImageBytes`, `ExportedFile`, and `ImportedDeck`. Each result lists in `warnings` what the other side cannot hold. The README "Limits" section lists what does not survive an import.

### Changed

- The colors of the web UI come from `agentic-design` tokens. The slide canvas sets `data-theme="light"`, so the selection and agent marks keep a light look on a deck of any theme. The present page uses the dark tokens.
- The package depends on `agentic-formats` 0.3.0.
- The README no longer says that ODP and PPTX export are not ready. The CLI, the MCP server, and the HTTP API do not use the formats subpath yet.

## 0.7.0 - 2026-10-29

Read the breaking changes before you upgrade or deploy.

### Breaking changes

- The room WebSocket reads the token from the subprotocol `agentic-slides.bearer.<token>`, with the token in base64url. The client must also offer `agentic-slides`. The old `bearer.<token>` form is gone. The bundled UI sends the new form.
- The package needs `agentic-identity` 0.6.0 or later. It uses the `agentic-identity` 0.6 HTTP and WebSocket auth helpers (`agentic-identity/http`) for the room token. The principal kinds come from `agentic-identity`, and the local `parsePrincipal` wraps the `agentic-identity` parser. A principal name must now start with a letter, a digit, `_`, or `-`. It then uses only A-Z a-z 0-9 . _ -, and it has 1 to 128 characters. A name with a space or another character makes the token setting invalid, and the server then refuses every request. The same rule applies to `--as`, `$SLIDES_AUTHOR`, and the MCP author. A token must use only A-Z a-z 0-9 _ - and have 32 to 512 characters, because the room route needs it.

## 0.6.1 - 2026-10-29

### Fixed

- The MCP bin, `agentic-slides-mcp`, answers `--help` and `-h` with the usage text and exits with 0. It answers `--version` and `-V` with the version. Before this fix, these flags started the stdio server, so the command did not return.

## 0.6.0 - 2026-10-29

Read the breaking changes before you upgrade or deploy.

### Breaking changes

- **Live names are checked.** `agentic-realtime` 0.4.0, which this release uses, accepts a peer name only if `isSafePeerName` accepts it. The client normalizes the name to NFC first. The Worker does not, so store the author names of your tokens in NFC form. The name has 1 to 40 characters. It starts with a letter or a digit. The other characters are letters, digits, spaces, or `. _ ' ’ ( ) -`. It has no space at either end, no two spaces in a row, no invisible character, and no run of four or more combining marks. The check runs in three places:
  - The `name` option of the live client, and `SLIDES_LIVE_NAME` for the CLI and the MCP server. A join with an unsafe name fails with `LIVE_UNAVAILABLE`. An empty `SLIDES_LIVE_NAME` also fails.
  - The author name of each token in `SLIDES_TOKENS`. The CLI and the MCP server use it when `SLIDES_LIVE_NAME` is not set. The web UI uses it for live presence. A deck page of a token with an unsafe name can show a blank page, with no error message. An email address fails, because it has `@`.
  - The Worker relays the author name of the token, not `SLIDES_LIVE_NAME`, when that name is safe. An unsafe author name shows to peers as `Unknown`.

  Before you upgrade, check each token author name and each live name with `isSafePeerName`, from `agentic-realtime`.

### Added

- **`agentic-slides/worker`.** The package exports its Worker entry as a subpath, so a host can import the Worker from npm. The README shows how to use it.
- **A live demo.** `wrangler.demo.jsonc` deploys a demo Worker, with its own D1 database and R2 bucket in the EU. `npm run deploy:demo` runs the deploy. The README has a Live demo section with the URL and the steps to redeploy. The demo token is a Worker secret only. These files are in the repository, not in the npm package.

### Changed

- The dependencies are the latest npm releases: `agentic-identity` 0.5.0 and `agentic-realtime` 0.4.0. The `agentic-design` dev dependency is 0.2.0. The tests of this repository pass on these versions. The source code of the HTTP API, the SDK, the CLI, and the MCP server did not change.

### Added

- `agentic-slides/ui` exports `mount`, which renders the deck editor into an element. `agentic-slides/ui.css` holds its styles.

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
