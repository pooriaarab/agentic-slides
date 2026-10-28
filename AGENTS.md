# agentic-slides agent guide

Build and present slide decks with people and agents.

## Mental model

A deck is a Yjs document. It holds ordered slides. A slide holds a layout, elements,
and speaker notes. All positions use one 1280 by 720 space.

## Where the code lives

- `src/core/deck.ts`: the `Deck` class and its operations.
- `src/core/outline.ts`: the outline format and its compiler.
- `src/core/layouts.ts`: layouts, the theme, and the text-fit estimate.
- `src/core/model.ts`: element types and inline marks.
- `src/core/principal.ts`: author kinds and error codes.
- `src/service.ts`: the operations that the CLI, the MCP server, and the API share. Slide positions are 1-based here.
- `src/ports.ts`, `src/store/file.ts`: the store and blob ports and the file adapters.
- `src/export/pdf.ts`: PDF export without a browser.
- `src/cli.ts`, `src/mcp.ts`: the faces. Keep them thin.
- `src/e2e/`: tests that run the built CLI and MCP server. Run `npm run build` first.
- `src/render/html.ts`, `src/render/present.ts`: deck and present pages. Escape all text. Load nothing remote.

## Rules

- Every operation takes an author. Keep the kind on every edit.
- Validate before you write. Yjs does not roll back a failed transaction.
- Write a failing test for a new failure mode before the code.
- Keep prose in ASD-STE100 Simplified Technical English.
