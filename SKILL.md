---
name: agentic-slides
description: Build and present slide decks with people and agents. Keywords: slides,presentation,deck,collaboration,agents,mcp,cli,pptx.
---

# agentic-slides

Build and present slide decks with people and agents.

## Use the SDK

```js
import { summarizeText, dispatchText } from "agentic-slides";

summarizeText("some text");
await dispatchText("some text", { dryRun: true });
```

## Use the CLI

```sh
agentic-slides summary --text "some text"
agentic-slides dispatch --text "some text" --dry-run
```

## Use the MCP server

Start the server with `agentic-slides mcp`. Call `summarize_text`
for stats, `dispatch_text` for routes, `get_cost_report` for costs.

## Rules

- Preview each route with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
