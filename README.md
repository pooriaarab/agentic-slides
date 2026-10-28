# agentic-slides

[![npm version](https://img.shields.io/npm/v/agentic-slides)](https://www.npmjs.com/package/agentic-slides)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Package](https://www.npmjs.com/package/agentic-slides) · [Source](https://github.com/pooriaarab/agentic-slides) · [Support](https://github.com/pooriaarab/agentic-slides/issues)

Build and present slide decks with people and agents.

> Status: early. The deck library and the HTML render work. The CLI, the MCP
> server, the HTTP API, and export are not ready yet. The package is not on npm yet.

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
- A bad outline fails with a code and a slide number. It never changes the deck.

## Outline format

Slides split at a line of `---`. A slide can hold `layout: <name>` as its first line,
`# Title`, body lines, `- ` items, `+++` for the next column, `|a|b|` table rows,
`![alt](path)` for one image, and `> note` for speaker notes.

## Limits

- Text fit is an estimate from font size and box size. It is the same on every run.
- An image must be a stored blob. A network address is refused.
- Setting a slide from an outline replaces all of its elements. Element ids change,
  and a box or a shape you added by hand is gone. A concurrent edit to the old
  elements is lost. Use `editElement` to change one element in place.
- Two writers who rewrite the same text with nothing in common at the same time keep
  one rewrite. Edits to different parts of a text both survive. Two writers who
  insert at the same spot both keep their text.
- Moving a slide changes only the order. Two writers who move one slide leave one copy.
- A font is a file in the asset root, and an image is a blob. The page links them by relative path.
- Elements cannot be added or deleted one by one yet.

## Develop

```sh
npm ci
npm run ci:local
```

## License

MIT.
