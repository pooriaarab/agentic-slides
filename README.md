# agentic-slides

[![npm version](https://img.shields.io/npm/v/agentic-slides)](https://www.npmjs.com/package/agentic-slides)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-slides) · [Source](https://github.com/pooriaarab/agentic-slides) · [Support](https://github.com/pooriaarab/agentic-slides/issues)

Build and present slide decks with people and agents.

> Status: early. The deck library, the HTML render, the CLI, the MCP server,
> PDF export, the HTTP API, live rooms, and the web UI work. The `agentic-slides/formats` library maps a deck to and from ODP and PPTX. The CLI, the MCP server, and the HTTP API do not use it yet.

## Install

```sh
npm install agentic-slides
```

## Quick start

```ts
import { Deck } from "agentic-slides";

const author = { kind: "agent_of_human", name: "writer-bot" } as const;
const deck = Deck.create({ title: "Launch", author });

deck.addSlidesFromOutline(
  ["layout: title", "# Launch plan", "Q4 kickoff", "---", "# Goals", "- **Ship** the beta", "- Train support", "> Say thanks."].join("\n"),
  { author },
);

console.log(deck.outline().slides.map((s) => s.title)); // ["Launch plan", "Goals"]
```

## CLI

```sh
export SLIDES_AUTHOR=human:ada            # or pass --as <kind:name> on each edit
npx agentic-slides new "Launch plan" --id plan
npx agentic-slides add plan --outline outline.md   # images are read next to the outline
npx agentic-slides outline plan                    # the deck as JSON
npx agentic-slides edit plan --slide 1 --element <id> --patch '{"text":"New **title**"}'
npx agentic-slides render plan --present --out deck.html
npx agentic-slides export plan --out deck.pdf
```

Decks live in `.slides/` (or `--dir`, or `$SLIDES_DIR`). Also: `list`, `move`, `delete` (a slide), `delete-deck`, and `edit --outline`.

To share a deck, use a server (see [Share a deck](#share-a-deck)). A local store has no roles, so these commands need `--live` and `$SLIDES_LIVE_TOKEN`:

```sh
export SLIDES_LIVE_URL=https://slides.example.com SLIDES_LIVE_TOKEN=<token>
npx agentic-slides grant plan --subject human:bob --role editor   # give a role (owner only)
npx agentic-slides revoke plan --subject human:bob                # take it away
npx agentic-slides access plan                                    # grants, invites, links (owner only)
npx agentic-slides invite plan --role viewer --handle bot         # or --email <address>. Prints the invite id
npx agentic-slides accept-invite <id>                             # an agent accepts, by the name of its token
npx agentic-slides share-link plan --role viewer --expires-in-ms 86400000   # prints the link token once
npx agentic-slides revoke-link plan --link <id>
```

A refused call prints `{"error":{"code":...}}` and exits 1: `UNAUTHORIZED` for a bad token, `FORBIDDEN` for a role that is too low, `NO_DECK` for a deck you cannot see.
Run `npx agentic-slides --help` for all flags.

### Join a live room

With `--live <url>` (or `SLIDES_LIVE_URL`) the CLI joins the live room of a deck on a server, in place of files.
Put the token in `SLIDES_LIVE_TOKEN`, never in a flag. The token sets who edits, so `--as`, `--dir`, and `SLIDES_AUTHOR` are refused.
The address must be `https://`. Plain `http://` works only for this machine.
Each command joins the room, makes one change, saves it to the stored deck, and leaves.

```sh
export SLIDES_LIVE_URL=https://slides.example.com
export SLIDES_LIVE_TOKEN=...      # an editor token
npx agentic-slides new "Launch plan" --id plan
npx agentic-slides add plan --outline outline.md   # a person's token or an agent's: the label follows the token
```

A server that is named but cannot be used is an error. The CLI never falls back to files.
Images are not available in a live room yet: use the HTTP API to add them.

## MCP server

Run `npx agentic-slides mcp`. The tools are `create_deck`, `list_decks`, `read_outline`, `add_slides`,
`set_slide`, `edit_element`, `move_slide`, `delete_slide`, `delete_deck`, `render_deck`, and `export_pdf`.
The server sets the author of every edit: `agent`, or the `SLIDES_AUTHOR` value. A model cannot
claim to be a human, and the server refuses to start with a `human` author. A failed call returns an error result with the issue list.

To join live rooms, set `SLIDES_LIVE_URL` and `SLIDES_LIVE_TOKEN` in the server environment. The server asks the
Worker who the token is, uses that author, and refuses a person's token. Each tool call joins the room, makes
its change, saves it, and leaves. A tool call never carries a credential.

In a live setting the server also has the sharing tools: `list_access`, `grant_access`, `revoke_access`, `invite`,
`accept_invite`, `create_share_link`, and `revoke_share_link`. They call the HTTP API, so the roles of the token apply.
A local store has no roles, so these tools do not exist there.

## Live demo

A demo Worker runs on workers.dev: <https://agentic-slides-demo.hello-fd1.workers.dev>

- `GET /health` answers 200 with no token.
- Every `/api/v1/slides` call needs a bearer token. The demo has no public token, so a call without one gets 401.
- It is a staging demo. Its data can be reset at any time. Do not store real content in it.
- It uses its own D1 database and R2 bucket, both in the EU.

To deploy your own copy, log in to Cloudflare (`npx wrangler login`), then create the D1 database and the R2 bucket.
Put the database id in `wrangler.demo.jsonc`:

```sh
export WRANGLER_SEND_METRICS=false
npx wrangler d1 create agentic-slides-demo --location weur
npx wrangler r2 bucket create agentic-slides-demo-images --jurisdiction eu
npm ci && npm run deploy:demo
```

The Worker signs requests in with agentic-identity credentials. Issue a credential for a principal in the same D1 database (see "Sign in" below). The demo needs no static token. If an earlier deploy has a `SLIDES_TOKENS` secret, delete it with `npx wrangler secret delete SLIDES_TOKENS -c wrangler.demo.jsonc`, or every API call answers 500.

To redeploy after a change, run `npm run deploy:demo` again. Put no token in a file or in CI.

## HTTP API

A Cloudflare Worker (Hono) serves `/api/v1/slides`. It mirrors the CLI.

### Sign in

The Worker uses agentic-identity auth. A bearer key or an access token in the Store (the `credentials` and `principals` collections of the `DB` binding) signs a request in. The principal and its kind name the author of each edit, so a client cannot claim a different kind. The scopes of the principal set the role:

- `slides:write` is an editor. A wildcard such as `*:admin` also covers it.
- `slides:read` is a viewer. It reads and cannot write.
- A valid credential with neither scope, or a principal id that cannot hold a deck role (it needs 1 to 128 of A-Z a-z 0-9 _ -), gets 403. No credential, an unknown one, or a revoked one gets 401.

Only a bearer token signs in. A session cookie does not. A store that fails gives a 5xx answer, never a 401. A checkpoint trusts the labels of room contributors that hold `slides:write` in the Store.

### Local dev path

For a local run you can use a static token list. It is off by default. Set `SLIDES_UNSAFE_STATIC_TOKENS=1` to turn it on. Then `SLIDES_TOKENS` (`token=kind:name,...`, each token 32 characters or more) signs requests in, and the identity credentials still work. Without the switch, a Worker that sets `SLIDES_TOKENS` answers every API call with 500 `MISCONFIGURED`. A static token cannot be revoked without a new deploy. Never set the switch in production.

Build first, because `wrangler.jsonc` serves `dist/ui`:

```sh
npm run build
WRANGLER_SEND_METRICS=false npx wrangler dev --var SLIDES_REGION:unknown --var SLIDES_UNSAFE_STATIC_TOKENS:1 \
  --var 'SLIDES_TOKENS:my-long-token-0123456789-abcdefghij=agent_of_human:bot'

curl -s -X POST localhost:8787/api/v1/slides/decks \
  -H 'authorization: Bearer my-long-token-0123456789-abcdefghij' -d '{"title":"Talk","id":"talk"}'
```

| Route | Does |
| --- | --- |
| `GET /decks?limit=&cursor=` | One page of decks, newest edit first, with the last editor of each. `nextCursor` names the next page. |
| `POST /decks` | Create a deck. |
| `GET /decks/:deck` | Read the outline. |
| `DELETE /decks/:deck` | Delete the deck, its list entry, and its sharing. On a deck with an owner, only an owner can delete it. On a deck with no owner, an editor token can delete it. |
| `POST /decks/:deck/slides` | Add slides from `outline` or one `layout`. |
| `PUT /decks/:deck/slides/:slide` | Replace one slide from an outline. |
| `PATCH /decks/:deck/slides/:slide/elements/:element` | Change one element. |
| `POST /decks/:deck/slides/:slide/move` | Move a slide (`{"to": 1}`). |
| `DELETE /decks/:deck/slides/:slide` | Delete a slide. |
| `GET /decks/:deck/render?present=1` | The HTML page. |
| `GET /decks/:deck/export` | The PDF. The headers hold the warning count and the first few warnings. |
| `GET /decks/:deck/export?envelope=json` | JSON with `pdfBase64`, `bytes`, and every warning. |

`:slide` is a slide id, or a 1-based position when all digits. With no token set, every call gets 401.
Images go in the `images` field as base64.

A token can end in `;viewer` (for example `token=human:eve;viewer`). A viewer reads. Every write by a viewer gets 403.
The default role is `editor`.

### Share a deck

The person or agent that makes a deck through the Worker owns it. An owner gives roles to others.
A role is `owner`, `editor`, `commenter`, or `viewer`.
Sharing needs a server. The HTTP API, `agentic-slides/client`, the CLI, and the MCP server all have sharing calls. The CLI and the MCP server use them in a live setting (see the CLI and MCP sections).

| Role | May |
| --- | --- |
| `viewer` | Read, render, export. |
| `commenter` | The same as a viewer. There are no comments yet. |
| `editor` | Also change slides, and join a live room as a writer. |
| `owner` | Also delete the deck, and use the routes below. |

A caller with no role on a deck gets the answer for a missing deck (404), and does not see it in `GET /decks`.
A caller with a role that is too low gets 403. The role works with the token role: a `;viewer` token only reads, even for an owner.

A token name must use only `A-Z a-z 0-9 _ -`. The subject of the token (see below) must have 1 to 128 characters. For a delegated kind, the kind and the underscore count. Otherwise the Worker refuses the token setting (500 `MISCONFIGURED`), because a name like that could hold no role.
A token holds roles as a subject. `GET /me` shows it. A `human` token is the subject `human:<name>`. An `agent` token is `agent:<name>`.
A token of another kind (for example `agent_of_human`) is the subject `agent:<kind>_<name>`. The Worker refuses an `agent` token with a name that starts with a delegated kind and an underscore (for example `agent_of_human_eve`), because it would share the subject of a delegated token.

| Route (owner only) | Does |
| --- | --- |
| `GET /decks/:deck/access?limit=&cursor=&inviteCursor=&linkCursor=` | The grants, invites, and links of the deck, one page of each. `nextCursor`, `nextInviteCursor`, and `nextLinkCursor` name the next pages. A link token and an invite email are never shown. |
| `POST /decks/:deck/grants` | Give a role: `{"subjectKind":"human","subjectId":"bob","role":"editor"}`. |
| `DELETE /decks/:deck/grants?subjectKind=&subjectId=` | Take a role away. The last owner stays. |
| `POST /decks/:deck/invites` | Invite by `email` (a person) or `handle` (an agent): `{"role":"viewer","handle":"bot","expiresInMs":86400000}`. It sends no message. |
| `POST /decks/:deck/links` | Make a share link: `{"role":"viewer","expiresInMs":86400000,"signedInOnly":false}`. The token comes back once. |
| `DELETE /decks/:deck/links/:link` | Revoke a link. |

| Route (any caller) | Does |
| --- | --- |
| `POST /invites/accept` | Accept an invite with `{"id":"..."}`. A token has no verified email, so this works for an invite by handle only. Only an `agent` token can accept: a delegated token needs a grant. |
| `GET /shared/:deck` | Read the outline with the link token in the `x-link-token` header. No bearer token is needed. |
| `GET /shared/:deck/render?present=1` | The HTML page, with the same header. |

A link gives read access only. A client must send the header: a plain page load of a browser cannot, so a link does not open in a browser by itself. A bad, revoked, or expired link gets 404, unless you also send a bearer token that holds a role on the deck. A bearer token that you send must be valid.
The Worker keeps the roles in the same D1 database as the decks. A deck made before sharing has no owner:
it keeps the token role check, and the share routes answer 403 for it. `createApp` takes a `store` for this. Without it, no roles apply.

A revoke closes the live room sockets of the person or agent that lost the role. The room refuses that caller until a new grant or an accepted invite. A grant of a lower role makes open sockets read only at once, and an accepted invite sets the room to the role that stands then.
`GET /decks` reads on until it fills the page with decks that the caller holds a role on. It reads at most 200 decks. If it stops there, it returns what it found and a `nextCursor` to go on.
If it finds a deck first, `nextCursor` stands after that deck. If it finds none, `nextCursor` is sealed with a key that the store holds, so the caller can pass it back and cannot read it. A list writes no audit row. A caller with more than 1000 roles sees the decks of the first 1000.
A caller with no role on a deck gets 404 and writes no audit row. A check for a caller with a role writes one audit row, and so does a link visit to a deck that has links. Limit the rate of `/shared` at the edge. A check that runs while a deck is deleted can leave a row that blocks the id for a new deck (`DECK_EXISTS`). The operator clears it from the `audit` collection. Deleting a deck erases the audit rows of its sharing: who held a role, and who shared it.

## UI

The Worker serves a small web UI at `/`. It uses the `agentic-design` package for tokens, controls, and
overlays, and the typed client (`agentic-slides/client`) for every call. It has:

- A deck list, with a form to make a deck.
- A slide sorter and a slide canvas. Pick a text box, a shape, or an image. Edit its text, fill, or
  description, and move it by drag, by the arrow keys, or by number.
- Add, move, and delete slides. Add an image slide from a PNG or JPEG file.
- Present mode: full screen, arrow keys, Page Up, Page Down, Space, Home, End, and Escape.
- Live presence in the room of the deck. A mark on a slide says that an agent edited it.
- Empty, loading, and error states. Light and dark themes. The UI works with the keyboard alone.

Run it on your machine. Build first, because the Worker serves `dist/ui`:

```sh
npm ci && npm run build
WRANGLER_SEND_METRICS=false npx wrangler dev --var SLIDES_REGION:unknown --var SLIDES_UNSAFE_STATIC_TOKENS:1 \
  --var 'SLIDES_TOKENS:my-long-token-0123456789-abcdefghij=human:ada,agent-token-0123456789-abcdefghij=agent_of_human:bot'
```

Open `http://localhost:8787/` and type a token. The token names who edits, and a tab keeps it until you
close it. An agent that uses the other token appears in presence, and its edits get the agent mark.

To serve the UI from the npm package in your own Worker, copy `wrangler.jsonc` from this repo. Change `main` to
`./node_modules/agentic-slides/dist/live-worker.js`, and change `assets.directory` to `./node_modules/agentic-slides/dist/ui`.
Keep the `DB`, `IMAGES`, and `SYNC_ROOM` bindings. The package ships `dist/ui`, so you do not need the source.
The package exports the API Worker as `agentic-slides/worker`. The default export is a Worker with a `fetch` handler.
`createWorker()` makes another one. It needs a D1 binding `DB` and an R2 binding `IMAGES`. Every route needs an agentic-identity credential (see "Sign in").

```ts
export { default } from "agentic-slides/worker";
```

The setup comments in `wrangler.jsonc` say how to create the D1 database and the R2 bucket, and how to issue credentials.

Test the UI in a browser. The tests start their own Workers, so run `npm run build` first. They need
Chromium once (`npx playwright install chromium`):

```sh
npm run e2e
```

They create a deck, add a slide, edit text, reload, and present with the arrow keys. They also check
the keyboard, presence between two browsers, the agent mark, a failed save, and a viewer. An axe check
(WCAG 2.2 AA) runs on every view in light and dark, including the error states and the viewer. `npm run e2e:screenshots` runs the same tests and writes the screenshots in
[docs/screenshots](docs/screenshots), for review. An axe check finds only part of the problems, so a person
should still check the keyboard and a screen reader.

The UI sends the token to the room as a WebSocket subprotocol (`agentic-slides.bearer.<token>`, with the token in base64url), because a browser cannot set a header on a WebSocket. Only the room route reads it.

### Mount the editor in your app

`agentic-slides/ui` renders the deck editor inside your own page. It needs no framework in your app. You give it
an element, a client, a deck id, and the principal who uses the editor. `mount` returns a handle.

```ts
import { createClient } from "agentic-slides/client";
import { mount } from "agentic-slides/ui";
import "agentic-design/styles.css";
import "agentic-slides/ui.css";

const client = createClient({ baseUrl: "https://slides.example.com", token });
const editor = mount(document.getElementById("slides")!, {
  client,
  docId: "talk",
  principal: { kind: "human", name: "Ada", role: "editor" },
  // readOnly: true,                    // open the deck read only, even for an editor
  // presence: { token },               // join the live room, to show who is here
  // onPresent: (slide) => { ... },     // handle Present yourself
});

editor.update({ client, docId: "other", principal });  // show another deck
editor.unmount();                                      // remove the editor and stop its poll
```

The principal needs a `kind` and a `name`. A missing or unknown `kind` throws a `TypeError`. Only the role
`editor` can change the deck. The server still checks every write against the token of the client.
Without `presence`, the editor shows no live presence. Without `onPresent`, Present sets the page address to
`#/deck/<id>/present/<slide>`. `react` and `react-dom` (version 19) are peer dependencies. The web UI that the
Worker serves renders the same editor component.

### Use your own Yjs document

An app that keeps decks in its own Yjs rooms gives the editor that document. Pass `host` in place of `client`.
The editor reads and writes the document, makes no HTTP call, and does not poll. It reads again at each change
of the document, from any writer.

```ts
import * as Y from "yjs";
import { mount } from "agentic-slides/ui";

const doc = new Y.Doc(); // your document, from your own provider
// `awareness` is from your provider. `storeIt` is your own function.
const editor = mount(document.getElementById("slides")!, {
  host: {
    doc,
    awareness,                              // optional: shows who is here
    putImage: async (bytes) => storeIt(bytes), // optional: returns "blob:sha256-<hash of the bytes>"
  },
  principal: { kind: "human", name: "Ada", role: "editor" },
});
```

- The document must come from the same copy of `yjs` as `agentic-slides`. A document from another copy throws a `TypeError`. Run `npm ls yjs` and remove the duplicate copies, so your app and this package share one copy.
- `awareness` needs `clientID`, `getStates`, `setLocalStateField`, `on`, and `off`, as a `y-protocols` awareness has. Each peer sets the field `user` to `{ name, kind? }`. The editor sets its own `user` and clears it on unmount. It never closes your room or your document.
- The editor shows only a deck that passes the checks that the service runs before it saves one. If a peer writes a bad theme or element, the editor keeps the last good deck on screen and shows "The deck could not refresh". It writes nothing while the document is invalid. It does not check the author labels that peers write. Your room must do that. A peer sets its own name and kind in the awareness. A peer with no kind, or kind `human`, shows as a person. Any other kind shows as an agent.
- Keep `putImage` the same function between `update` calls. A new function makes the editor read the document again.
- Each edit carries the kind of the principal, so an agent edit has the agent mark. Your app checks who may write: give `role: "viewer"` to open the deck read only.
- Without `putImage`, the editor adds no image slide. Pictures stay `blob:` references. The editor does not keep the bytes. It checks each picture first (PNG or JPEG, the size and pixel limits of the service) and calls `putImage` only for a good one. `putImage` must return `blob:sha256-` and the SHA-256 of the bytes in hex. If the edit fails after `putImage` stored a picture, the picture stays in your store with no slide.
- Host edits have no size cap in the editor. The size limit is the limit of your own room or store.
- Give no `client` and no `presence` with `host`. `docId` is optional with `host`.
- Present needs `onPresent` in host mode, because only the Worker UI has a present page. Without it, Present is off.
- The status says "Presence on" when you give `awareness`. It does not know if your provider is online.
- The document is a deck as `agentic-slides` stores it. Make one with `Deck.create` from `agentic-slides`, or open an existing one.

## SDK

`agentic-slides/client` is a typed client for the HTTP API. It uses only `fetch`. It runs in
browsers, Workers, and Node 22.

```ts
import { createClient, SlidesApiError } from "agentic-slides/client";

const slides = createClient({ baseUrl: "https://slides.example.com", token });
await slides.createDeck({ title: "Talk", id: "talk" });
const { slideIds } = await slides.addSlides("talk", { outline: "# Hello\n- first point" });
const pdf = await slides.exportPdf("talk", { signal: AbortSignal.timeout(10_000) });

// Share the deck. These calls need an owner, except acceptInvite and readShared.
await slides.grant("talk", { subject: { kind: "human", id: "bob" }, role: "editor" });
const { id: inviteId } = await slides.invite("talk", { role: "viewer", handle: "bot" });
const { id: linkId, token: linkToken } = await slides.createShareLink("talk", { role: "viewer", expiresInMs: 86_400_000 });
const { grants, invites, links } = await slides.access("talk");
await slides.revokeShareLink("talk", linkId);
await slides.revoke("talk", { kind: "human", id: "bob" });
```

The client has these methods: `health`, `me`, `listDecks`, `createDeck`, `deleteDeck`, `outline`, `addSlides`, `setSlide`,
`editElement`, `moveSlide`, `deleteSlide`, `render`, `exportPdf`, `state`, and `checkpoint`. For sharing, it has
`access`, `grant`, `revoke`, `invite`, `acceptInvite`, `createShareLink`, `revokeShareLink`, and `readShared`. `readShared` also sends the token of the client, and the server needs it to be valid. A visitor with only a link token reads with `GET /shared/:deck` and the header. Each method
takes `{ signal }` as its last argument. Pass `fetch` to `createClient` to replace the global one.

When the API refuses a call, the method throws `SlidesApiError`. It has `status` (the HTTP status),
`code` (the API error code, such as `NO_DECK` or `UNAUTHORIZED`), `message`, and `issues`. An abort
and a network failure throw the error of `fetch`. The client never retries a call, so a write is sent once.
The live room route is not in the client. Use `LiveDeck` from `agentic-slides/live`.

## ODP and PPTX

`agentic-slides/formats` maps a deck to and from open slide files. The file code is in `agentic-formats`.
It runs in Node and in Workers.

```ts
import { deckToPptx, outlineFromPptx } from "agentic-slides/formats";

const { bytes, warnings } = deckToPptx(await service.outline("talk"), images); // images: Map of blob ref to bytes
const imported = outlineFromPptx(bytes); // { outline, images, warnings }
```

`deckToOdp` and `outlineFromOdp` do the same for ODP. Each result has `warnings` for content that the other side
cannot hold. An import returns outline text and image files. Add them with `addSlides`. The import does not keep
the layout of the file: the top text box is the title, other text becomes bullets, and the first picture is the image.
A file that is not safe or not valid throws `FormatError` from `agentic-formats`.

## Live rooms

The Worker hosts one live room for each deck. A room is a Durable Object from
[agentic-realtime](https://www.npmjs.com/package/agentic-realtime). A person and
an agent edit the same deck at the same time, and both see the other's changes.

| Route | Does |
| --- | --- |
| `GET /decks/:deck/ws` | Join the room over a WebSocket (Yjs protocol). The deck must exist. |
| `GET /me` | The kind, name, and role of the token. |
| `GET /decks/:deck/state` | The stored deck as a Yjs update. A client seeds an empty room with it. |
| `POST /decks/:deck/checkpoint` | Merge the room state into the stored deck. It checks the update first. |

The token sets the author kind and the role. A client cannot change either. A viewer joins and
reads, and the room drops its edits. The room keeps its state in the Durable Object, so a restart
keeps it. A checkpoint saves the state to the store, so the HTTP API and the CLI see it.

A checkpoint is checked before it is saved. Every element must follow the rules of an edit (box inside the slide,
known fields, image sources that are blob keys). Each new or changed item must carry an author label of the caller, or of a
person or agent that the room saw send an update. Otherwise the server answers 403 and saves nothing. Inside one room, a
writer can still label a change as another writer of that room.

### Join a live room from code

This needs Node 22 or later. It does not work in a browser yet: the token goes in a WebSocket header.

```ts
import { LiveDeck } from "agentic-slides/live";

const live = await LiveDeck.join("plan", { server: "https://slides.example.com", token });
await live.edit((deck, author) => deck.addSlide({ layout: "section" }, author)); // waits for the room
console.log(live.peers); // the other people and agents; `machine` is true for an agent
await live.save(); // the server checks the room state, then stores it
await live.leave();
```

## Account export and erase

A host that must export or erase the data of one person or agent uses `agentic-slides/account`. It never reads the storage layout.

```ts
import { slidesAccount } from "agentic-slides/account";

const data = await slidesAccount.exportAccount({ kind: "human", id: "ana" }, { store });
const counts = await slidesAccount.eraseAccount({ kind: "human", id: "ana" }, { store });
```

The export has three collections: `decks` (decks the subject owns, with the outline), `grants` (roles the subject holds), and `authored` (slides and elements the subject wrote in decks of other people). The erase deletes each deck where the subject is the only owner. It removes the other roles. It replaces the subject as author with `erased` and keeps the author kind. The outline of an owned deck is exported as it is, with the author names of other people in it. A second erase counts zero. Run it with writes stopped. The plug-in does not reach live rooms: the host must close them first, or a room can save the deck again. Run `migrateGrants` of `agentic-identity` before the erase: a grant from an old store has no subject kind, and the erase cannot find it. Audit rows of grant changes belong to `agentic-identity`. When a deck has two owners, the erase revokes the grant of the subject through `agentic-identity`, and that writes one audit row. Erase the audit rows after this plug-in.

## Features

- Slides on a fixed 1280 by 720 space (16:9), kept in a Yjs document.
- Layouts: `title`, `title-body`, `section`, `two-column`, `image-right`, `blank`.
- Elements: text with bold and italic, shapes, images, and tables.
- Speaker notes and a theme with color tokens and self-hosted fonts.
- Operations that run in Node with no browser: read the deck as an outline,
  add, move, and delete a slide, set a slide from a text outline, edit one element.
- Every edit records who made it. Content from an agent is marked `machineMade`.
- `renderDeck` makes one HTML page of all slides (it prints one slide per page).
  `renderPresent` makes a present page: arrow keys move, `N` shows speaker notes,
  `F` goes full screen. Both pages load nothing from the network.
- PDF export draws each slide on a 1280 by 720 page with no browser.
- A bad outline fails with a code and a slide number. It never changes the deck.

## Outline format

Slides split at a line of `---`. A slide can hold `layout: <name>` as its first line,
`# Title`, body lines, `- ` items, `+++` for the next column, `|a|b|` table rows,
`![alt](path)` for one image, and `> note` for speaker notes.

## Limits

- ODP and PPTX: a table is written as text. Text color, font size, and shapes do not survive an import. A star in imported text becomes the asterisk operator, because an outline has no escape. Bold italic text keeps only bold. A list is written with a "•" in the text, because the neutral deck has no list paragraph. A slide with more text than its box holds fails the add with `TEXT_OVERFLOW`: shorten the outline text and add it again.
- Text fit is an estimate from font size and box size. It is the same on every run.
- An image must be a stored blob (`blob:sha256-<64 hex digits>`). A network address is refused.
  An image that is gone from the store, or cannot be decoded, draws as a placeholder
  in HTML and PDF. The PDF export lists it in `warnings`.
- The CLI reads image files only from the outline's own folder, and refuses a file over 10 MB.
- Several processes can share one store directory. Each edit takes a lock on the deck. A
  lock that a dead process left is taken over after 30 seconds. A live lock that does not
  free in 10 seconds fails the edit with `STORE_BUSY`.
- Export limits: 200 slides, 4000 elements, 25 million pixels and 10 MB per image,
  64 MB of images in total, and 20 seconds. A deck over a limit fails with `EXPORT_LIMIT`.
- PDF export lists text that does not fit its box in `warnings`. It cuts that text.
- Setting a slide from an outline replaces all of its elements. Element ids change,
  and a box or a shape you added by hand is gone. A concurrent edit to the old
  elements is lost. Use `editElement` to change one element in place.
- Two writers who rewrite the same text with nothing in common at the same time keep
  one rewrite. Edits to different parts of a text both survive. Two writers who
  insert at the same spot both keep their text.
- Moving a slide changes only the order. Two writers who move one slide leave one copy.
- A font is a file in the asset root, and an image is a blob. The page links them by relative path.
  Nothing serves or inlines the font files yet, so a page falls back to the font stack.
- The present page holds the speaker notes of every slide. Anyone who can open it can read them in the page source.
- The deck page runs no script. The present page runs one fixed script, and its CSP names that script by hash.
- PDF text uses Noto Sans (SIL OFL 1.1), cut down to Latin, Latin Extended, Greek, and Cyrillic.
  The font ships in the package and is embedded as a subset, so a PDF stays small and the
  bytes are the same on every run. Han, Arabic, Indic, and other scripts become `?` and are
  listed in `warnings`. The PDF has no tags yet.
- The Worker keeps decks in D1 and images in R2. Create both in the EU (see `wrangler.jsonc`). It declares the `eu` region and refuses a D1 query that D1 does not report as served in the EU. `SLIDES_REGION:unknown` turns that check off, for local runs only. A deck made through the Worker has an owner, and only its roles decide who reads or changes it. A deck made before 0.9.0 has no owner. Any valid token can read it, and an editor token can change it. Its share routes answer 403.
- A token has 32 to 512 characters, from A-Z a-z 0-9 _ -. A principal name starts with a letter, a digit, `_`, or `-`, then uses only A-Z a-z 0-9 . _ -, and has 1 to 128 characters. The Worker is stricter for token names: see Share a deck. A request holds at most 20 images, 10 MB each, and 32 MB in all.
- A change reaches the room before the server checks the size, so an edit that makes a deck too large for a room stays in the room and makes every save fail until someone removes it.
- A live room and the HTTP API are two copies of a deck. A CLI or MCP call in a live room saves after each change, so the HTTP API sees it at once. An HTTP edit reaches a room on the next join, not at once. Save a room with a checkpoint.
- A checkpoint holds at most 1.5 MiB. A deck over that cannot go in a room.
- Elements cannot be added or deleted one by one yet. The canvas edits the elements that a layout makes.
- The UI shows an image as a box with its description. The API has no route to read one image yet.
- In host mode, the document must hold a deck. An empty `Y.Doc` shows "this document holds no deck", and the editor writes nothing to it. Make the deck with `Deck.create`.
- In client mode, the UI uses the room for presence only. Its edits go through the HTTP API, and it reads the deck again every 3 seconds.
- A deck that someone edits while a person pages through the list moves to the front, so it can be missing from the later pages of that walk. Load the list again to see it.
- The deck list reads a small index that each save writes. A deck that nobody edited since this version is not in the list until its next edit.

## Run locally

```sh
bun install        # or: npm ci
bun run dev        # or: npm run dev
curl http://localhost:8787/health
```

The script builds the app, then runs `wrangler dev` with the region set to `unknown` (`SLIDES_REGION=unknown`), because local D1 reports no region. Do not use this value in production. `/health` needs no token. To sign in to the UI on your machine only, pass a static token: `TOKEN=$(openssl rand -hex 24); echo "$TOKEN"; npm run dev -- --var SLIDES_UNSAFE_STATIC_TOKENS:1 --var "SLIDES_TOKENS:$TOKEN=human:ada"`.

The scripts call `npm` and `node` (Node 22 or newer), so install both, even if you use bun. They need a POSIX shell.

Run `npm run dev:smoke` to check this path. It starts the dev server on port 8799, waits for `GET /health` to answer 200, and stops the server. CI runs it as the "dev smoke" step. Set `DEV_SMOKE_PORT` to use another port.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
