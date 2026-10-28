# agentic-slides

[![npm version](https://img.shields.io/npm/v/agentic-slides)](https://www.npmjs.com/package/agentic-slides)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-slides) · [Source](https://github.com/pooriaarab/agentic-slides) · [Support](https://github.com/pooriaarab/agentic-slides/issues)

Build and present slide decks with people and agents.

> Status: early. The deck library, the HTML render, the CLI, the MCP server, and
> PDF export work. The HTTP API, ODP, and PPTX export are not ready yet. The package is not on npm yet.

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

## MCP server

Run `npx agentic-slides mcp`. The tools are `create_deck`, `read_outline`, `add_slides`,
`set_slide`, `edit_element`, `move_slide`, `delete_slide`, `render_deck`, and `export_pdf`.
The server sets the author of every edit: `agent`, or the `SLIDES_AUTHOR` value. A model cannot
claim to be a human, and the server refuses to start with a `human` author. A failed call returns an error result with the issue list.

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
- PDF text uses Helvetica. A character outside Latin-1 becomes `?` and is listed in `warnings`. The PDF has no tags yet.
  An open font for all scripts is next on the list.
- Elements cannot be added or deleted one by one yet.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
