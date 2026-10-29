# agentic-slides

[![npm version](https://img.shields.io/npm/v/agentic-slides)](https://www.npmjs.com/package/agentic-slides)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-slides) · [Source](https://github.com/pooriaarab/agentic-slides) · [Support](https://github.com/pooriaarab/agentic-slides/issues)

Build and present slide decks with people and agents.

> Status: early. The deck library, the HTML render, the CLI, the MCP server,
> PDF export, the HTTP API, and live rooms work. ODP and PPTX export are not ready yet.

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

Decks live in `.slides/` (or `--dir`, or `$SLIDES_DIR`). Also: `move`, `delete`, and `edit --outline`.
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

Run `npx agentic-slides mcp`. The tools are `create_deck`, `read_outline`, `add_slides`,
`set_slide`, `edit_element`, `move_slide`, `delete_slide`, `render_deck`, and `export_pdf`.
The server sets the author of every edit: `agent`, or the `SLIDES_AUTHOR` value. A model cannot
claim to be a human, and the server refuses to start with a `human` author. A failed call returns an error result with the issue list.

To join live rooms, set `SLIDES_LIVE_URL` and `SLIDES_LIVE_TOKEN` in the server environment. The server asks the
Worker who the token is, uses that author, and refuses a person's token. Each tool call joins the room, makes
its change, saves it, and leaves. A tool call never carries a credential.

## HTTP API

A Cloudflare Worker (Hono) serves `/api/v1/slides`. It mirrors the CLI. Set tokens as a secret.
Each token names who edits, so a client cannot claim a different kind:

```sh
WRANGLER_SEND_METRICS=false npx wrangler dev --var SLIDES_REGION:unknown \
  --var 'SLIDES_TOKENS:my-long-token-0123456789-abcdefghij=agent_of_human:bot'

curl -s -X POST localhost:8787/api/v1/slides/decks \
  -H 'authorization: Bearer my-long-token-0123456789-abcdefghij' -d '{"title":"Talk","id":"talk"}'
```

| Route | Does |
| --- | --- |
| `POST /decks` | Create a deck. |
| `GET /decks/:deck` | Read the outline. |
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

## SDK

`agentic-slides/client` is a typed client for the HTTP API. It uses only `fetch`. It runs in
browsers, Workers, and Node 22.

```ts
import { createClient, SlidesApiError } from "agentic-slides/client";

const slides = createClient({ baseUrl: "https://slides.example.com", token });
await slides.createDeck({ title: "Talk", id: "talk" });
const { slideIds } = await slides.addSlides("talk", { outline: "# Hello\n- first point" });
const pdf = await slides.exportPdf("talk", { signal: AbortSignal.timeout(10_000) });
```

There is one method for each route: `health`, `me`, `createDeck`, `outline`, `addSlides`, `setSlide`,
`editElement`, `moveSlide`, `deleteSlide`, `render`, `exportPdf`, `state`, and `checkpoint`. Each method
takes `{ signal }` as its last argument. Pass `fetch` to `createClient` to replace the global one.

When the API refuses a call, the method throws `SlidesApiError`. It has `status` (the HTTP status),
`code` (the API error code, such as `NO_DECK` or `UNAUTHORIZED`), `message`, and `issues`. An abort
and a network failure throw the error of `fetch`. The client never retries a call, so a write is sent once.
The live room route is not in the client. Use `LiveDeck` from `agentic-slides/live`.

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
- The Worker keeps decks in D1 and images in R2. Create both in the EU (see `wrangler.jsonc`). It declares the `eu` region and refuses a D1 query that D1 does not report as served in the EU. `SLIDES_REGION:unknown` turns that check off, for local runs only. Any valid token can read every deck, and an editor token can change every deck: there is no owner and no per-deck role yet, so do not use it for more than one tenant.
- A token has 32 or more characters. A request holds at most 20 images, 10 MB each, and 32 MB in all.
- A change reaches the room before the server checks the size, so an edit that makes a deck too large for a room stays in the room and makes every save fail until someone removes it.
- A live room and the HTTP API are two copies of a deck. A CLI or MCP call in a live room saves after each change, so the HTTP API sees it at once. An HTTP edit reaches a room on the next join, not at once. Save a room with a checkpoint.
- A checkpoint holds at most 1.5 MiB. A deck over that cannot go in a room.
- Elements cannot be added or deleted one by one yet.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
