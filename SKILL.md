---
name: agentic-slides
description: Build and edit slide decks from an outline. Every edit records its author.
---

# agentic-slides

Status: early. Only the SDK works today.

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
- A failed outline lists all its issues. Fix them all.
- Images come from stored blobs, never from a URL.
