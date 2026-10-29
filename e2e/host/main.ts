// A host page: it keeps its own Y.Doc and mounts the editor on it, bundled from source. It makes no request to a slides server.
import * as Y from "yjs";
import { Deck } from "../../src/core/deck.js";
import { mount } from "../../ui/embed.js";
import "agentic-design/styles.css";
import "../../ui/app.css";

const doc = new Y.Doc();
const ada = { kind: "human", name: "Ada" } as const;
const deck = Deck.create({ title: "Host deck", author: ada }, undefined);
Y.applyUpdate(doc, deck.encode());
const host = new Deck(doc);
host.addSlidesFromOutline("# Welcome\n- First point\n- Second point\n> Say hello\n---\nlayout: title\n# Thank you", { author: { kind: "agent_of_human", name: "bot" } });

(window as unknown as { hostDeck: Deck }).hostDeck = host;
mount(document.getElementById("slides")!, { host: { doc }, principal: { ...ada, role: "editor" } });
