---
name: agentic-slides
description: Build and edit slide decks from an outline with a CLI, an MCP server, or an SDK. Every edit records its author.
---

# agentic-slides

## Use the CLI

```sh
export SLIDES_AUTHOR=agent_of_human:my-bot
agentic-slides new "Talk" --id talk
agentic-slides add talk --outline outline.md
agentic-slides outline talk
agentic-slides export talk --out talk.pdf
```

## Use the MCP server

Start it with `agentic-slides mcp`. Call `read_outline` first. Then call `add_slides`,
`set_slide`, `edit_element`, `move_slide`, or `delete_slide`. End with `export_pdf` or `render_deck`.

## Use the HTTP API

Send `Authorization: Bearer <token>` to `/api/v1/slides`. See the README for the routes.
The token sets your author kind. Do not send an author in the body.

## Use the SDK

```js
import { Deck } from "agentic-slides";

const author = { kind: "agent_of_human", name: "writer-bot" };
const deck = Deck.create({ title: "Talk", author });
deck.addSlidesFromOutline("# One\n- point", { author });
deck.outline();
```

## Rules

- Pass your real author kind on every call.
- A failed outline lists all its issues. Fix them all, then retry once.
- Images come from PNG or JPEG files, never from a URL.
