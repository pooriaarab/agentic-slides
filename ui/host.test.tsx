// @vitest-environment jsdom
import { act } from "react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Deck } from "../src/core/deck.js";
import type { SlidesClient } from "../src/client.js";
import { mount, type EmbedPrincipal, type MountedSlides } from "./embed.js";
import type { AwarenessLike } from "./host.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const ada: EmbedPrincipal = { kind: "human", name: "Ada", role: "editor" };
const bot: EmbedPrincipal = { kind: "agent_of_human", name: "Bot", role: "editor" };
const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
// jsdom has no Blob.arrayBuffer.
const picture = (name: string, bytes: number[]) => Object.assign(new File([new Uint8Array(bytes)], name), { arrayBuffer: async () => new Uint8Array(bytes).buffer });
/** The first bytes of a 1 by 1 PNG. The checks read only the header. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const refOf = (bytes: Uint8Array) => `blob:sha256-${bytesToHex(sha256(bytes))}`;
const pick = async (host: HTMLElement, file: File) => {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => void input.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
};
const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

/** A host document with a deck that a person made. */
function hostDoc(title = "Host deck") {
  const deck = Deck.create({ title, author: { kind: "human", name: "Ada" } });
  deck.addSlidesFromOutline("# First\n- point", { author: { kind: "human", name: "Ada" } });
  return { deck, doc: deck.doc };
}

/** The awareness shape that `y-protocols` has, with no network. */
function fakeAwareness(clientID = 1) {
  const states = new Map<number, Record<string, unknown>>();
  const listeners = new Set<() => void>();
  const awareness: AwarenessLike = {
    clientID,
    getStates: () => states,
    setLocalStateField: (field, value) => {
      states.set(clientID, { ...states.get(clientID), [field]: value });
      listeners.forEach((l) => l());
    },
    on: (_e, l) => void listeners.add(l),
    off: (_e, l) => void listeners.delete(l),
  };
  const peer = (id: number, state: Record<string, unknown>) => (states.set(id, state), listeners.forEach((l) => l()));
  return { awareness, states, listeners, peer };
}

const DOC: { current?: Y.Doc } = {};
const PUT: { current?: (bytes: Uint8Array) => Promise<string> } = {};
let host: HTMLElement;
let mounted: MountedSlides | undefined;
const fetchSpy = vi.fn(async () => new Response("no", { status: 500 }));
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  vi.stubGlobal("fetch", fetchSpy);
  fetchSpy.mockClear();
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("host document mode", () => {
  it("shows the host deck and makes no HTTP call", async () => {
    const { doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Host deck");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes an edit to the host document with the kind of the principal", async () => {
    const { deck, doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: bot })));
    await settle();
    await act(async () => button(host, "Add slide").click());
    await settle();
    const outline = deck.outline();
    expect(outline.slides).toHaveLength(2);
    expect(outline.slides[1]!.createdBy).toEqual({ kind: "agent_of_human", name: "Bot" });
    expect(outline.slides[1]!.machineMade).toBe(true);
    expect(host.textContent).toContain("Agent edit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("moves and deletes slides in the host document", async () => {
    const { deck, doc } = hostDoc();
    deck.addSlidesFromOutline("# Second", { author: { kind: "human", name: "Ada" } });
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    await act(async () => button(host, "Move slide later").click());
    await settle();
    expect(deck.outline().slides.map((s) => s.title)).toEqual(["Second", "First"]);
    await act(async () => button(host, "Delete slide").click());
    await act(async () => void [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete slide" && !b.getAttribute("aria-label"))!.click());
    await settle();
    expect(deck.outline().slides).toHaveLength(1);
  });

  it("sets no poll timer and reads only when the document changes", async () => {
    vi.useFakeTimers();
    const { doc } = hostDoc();
    const outline = vi.spyOn(Deck.prototype, "outline");
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    const reads = outline.mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(30_000)));
    expect(outline.mock.calls.length).toBe(reads);
    outline.mockRestore();
  });

  it("makes one read for many changes in one tick", async () => {
    const { deck, doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    const outline = vi.spyOn(Deck.prototype, "outline");
    await act(async () => {
      for (let i = 0; i < 5; i++) deck.addSlidesFromOutline(`# Slide ${i}`, { author: { kind: "human", name: "Eve" } });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(outline).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll(".sorter li")).toHaveLength(6);
    outline.mockRestore();
  });

  it("redraws at a change from another writer, with no poll", async () => {
    vi.useFakeTimers();
    const { deck, doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(host.querySelectorAll(".sorter li")).toHaveLength(1);
    await act(async () => void deck.addSlidesFromOutline("# From a peer", { author: { kind: "agent", name: "Peer" } }));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    expect(host.querySelectorAll(".sorter li")).toHaveLength(2);
  });

  it("opens read only and writes nothing for a viewer", async () => {
    const { doc } = hostDoc();
    const updates = vi.fn();
    doc.on("update", updates);
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: { ...ada, role: "viewer" } })));
    await settle();
    expect(button(host, "Add slide").disabled).toBe(true);
    expect(updates).not.toHaveBeenCalled();
  });

  it("stops watching the document on unmount and leaves the document open", async () => {
    const { doc } = hostDoc();
    const before = (doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get("update")?.size ?? 0;
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect((doc as unknown as { _observers: Map<string, Set<unknown>> })._observers.get("update")?.size ?? 0).toBe(before);
    expect(doc.isDestroyed).toBe(false);
  });

  it("shows the peers in the host awareness, announces this tab, and takes it back on unmount", async () => {
    const { doc } = hostDoc();
    const { awareness, states, listeners, peer } = fakeAwareness();
    await act(async () => void (mounted = mount(host, { host: { doc, awareness }, principal: ada })));
    await settle();
    expect(states.get(1)!.user).toEqual({ name: "Ada", kind: "human" });
    await act(async () => peer(2, { user: { name: "Robo", kind: "agent" } }));
    expect(host.querySelector('[aria-label="Here now"]')?.innerHTML).toContain("Robo, agent");
    expect(host.querySelector('[aria-label="Here now"]')?.innerHTML).not.toContain("Ada");
    expect(host.textContent).toContain("Presence on");
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(listeners.size).toBe(0);
    expect(states.get(1)!.user).toBeNull();
  });

  it("keeps the other fields of the host's user state, and gives them back on unmount", async () => {
    const { doc } = hostDoc();
    const { awareness, states } = fakeAwareness();
    states.set(1, { user: { name: "Old", color: "#336699" } });
    await act(async () => void (mounted = mount(host, { host: { doc, awareness }, principal: ada })));
    await settle();
    expect(states.get(1)!.user).toEqual({ name: "Ada", color: "#336699", kind: "human" });
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(states.get(1)!.user).toEqual({ name: "Old", color: "#336699" });
  });

  it("keeps a name that the host set while the editor was mounted", async () => {
    const { doc } = hostDoc();
    const { awareness, states } = fakeAwareness();
    await act(async () => void (mounted = mount(host, { host: { doc, awareness }, principal: ada })));
    await settle();
    awareness.setLocalStateField("user", { name: "Host name", kind: "host-kind", color: "#112233" });
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(states.get(1)!.user).toEqual({ name: "Host name", kind: "host-kind", color: "#112233" });
  });

  it("cuts a long peer name", async () => {
    const { doc } = hostDoc();
    const { awareness, peer } = fakeAwareness();
    await act(async () => void (mounted = mount(host, { host: { doc, awareness }, principal: ada })));
    await settle();
    await act(async () => peer(2, { user: { name: "x".repeat(100_000) } }));
    expect(host.innerHTML.length).toBeLessThan(20_000);
  });

  it("keeps a field that the host changed while the editor was mounted", async () => {
    const { doc } = hostDoc();
    const { awareness, states } = fakeAwareness();
    await act(async () => void (mounted = mount(host, { host: { doc, awareness }, principal: ada })));
    await settle();
    awareness.setLocalStateField("user", { ...(states.get(1)!.user as object), color: "#112233" });
    await act(async () => mounted!.unmount());
    mounted = undefined;
    expect(states.get(1)!.user).toEqual({ color: "#112233" });
  });

  it("disables image slides without putImage, and stores the picture through it when given", async () => {
    const { deck, doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    expect(button(host, "Add image slide").disabled).toBe(true);
    await act(async () => mounted!.unmount());
    const putImage = vi.fn(async (bytes: Uint8Array) => refOf(bytes));
    await act(async () => void (mounted = mount(host, { host: { doc, putImage }, principal: ada })));
    await settle();
    expect(button(host, "Add image slide").disabled).toBe(false);
    await pick(host, picture("cat.png", [...PNG]));
    expect(putImage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deck.outline())).toContain(refOf(PNG));
  });

  it.each([
    ["a remote address", PNG, 1, async () => "https://example.com/x.png"],
    ["a reference for other bytes", PNG, 1, async () => `blob:sha256-${"a".repeat(64)}`],
    // The bytes that fail a check never reach the host's store.
    ["a file that is not a PNG or JPEG", new Uint8Array([60, 104, 116, 109, 108, 62]), 0, async (b: Uint8Array) => refOf(b)],
    ["a picture with too many pixels", Uint8Array.from([...PNG.slice(0, 16), 0, 1, 0, 0, 0, 1, 0, 0]), 0, async (b: Uint8Array) => refOf(b)],
  ])("shows a message and writes nothing for %s", async (_label, bytes, calls, ref) => {
    const { deck, doc } = hostDoc();
    const putImage = vi.fn(ref);
    await act(async () => void (mounted = mount(host, { host: { doc, putImage }, principal: ada })));
    await settle();
    await pick(host, picture("x.png", [...bytes]));
    expect(deck.outline().slides).toHaveLength(1);
    expect(document.body.textContent).toContain("The image slide was not added");
    expect(putImage).toHaveBeenCalledTimes(calls);
  });

  it("shows an error, with no edit button, for a document that holds no deck", async () => {
    const doc = new Y.Doc();
    const updates = vi.fn();
    doc.on("update", updates);
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    expect(host.textContent).toContain("this document holds no deck");
    expect(host.querySelector("button[aria-label='Add slide']")).toBeNull();
    expect(updates).not.toHaveBeenCalled();
  });

  it("writes nothing when a peer made the deck invalid after the last good read", async () => {
    const { deck, doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    const updates = vi.fn();
    // A refresh that fails keeps the old deck on screen. The edit buttons must not write to the new state.
    doc.getMap("deck").set("theme", { colors: { background: "url(https://tracker.example/p.png)" }, fonts: {} });
    doc.on("update", updates);
    await act(async () => button(host, "Add slide").click());
    await settle();
    expect(updates).not.toHaveBeenCalled();
    expect(deck.doc.getArray("order").length).toBe(1);
    expect(document.body.textContent).toContain("The slide was not added");
  });

  it.each([
    ["a theme that loads a remote address", (doc: Y.Doc) => doc.getMap("deck").set("theme", { colors: { background: "url(https://tracker.example/p.png)" }, fonts: {} })],
    ["a theme that is not an object", (doc: Y.Doc) => doc.getMap("deck").set("theme", "x")],
    ["a slide that is not made as the Deck class makes one", (doc: Y.Doc) => (doc.getMap("slides").get([...doc.getMap("slides").keys()][0]!) as Y.Map<unknown>).set("elements", "x")],
  ])("keeps the last good deck on screen and shows a banner for %s", async (_label, spoil) => {
    const { doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    expect(host.querySelectorAll(".sorter li")).toHaveLength(1);
    await act(async () => void spoil(doc));
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("The deck could not refresh");
    expect(host.querySelectorAll(".sorter li")).toHaveLength(1);
    expect(host.innerHTML).not.toContain("tracker.example");
  });

  it("writes nothing when a peer spoils the document while putImage runs", async () => {
    const { doc } = hostDoc();
    const putImage = vi.fn(async (bytes: Uint8Array) => {
      doc.getMap("deck").set("theme", { colors: { background: "url(https://tracker.example/p.png)" }, fonts: {} });
      return refOf(bytes);
    });
    await act(async () => void (mounted = mount(host, { host: { doc, putImage }, principal: ada })));
    await settle();
    const updates = vi.fn();
    doc.on("update", updates);
    await pick(host, picture("x.png", [...PNG]));
    // The only update is the peer's own theme change.
    expect(updates).toHaveBeenCalledTimes(1);
    expect(doc.getArray("order").length).toBe(1);
  });

  it.each([
    ["the editor unmounts", async () => void (await act(async () => (mounted!.unmount(), (mounted = undefined))))],
    ["the person becomes a viewer", async () => void (await act(async () => mounted!.update({ host: { doc: DOC.current!, putImage: PUT.current! }, principal: { ...ada, role: "viewer" } })))],
  ])("writes nothing when %s while putImage runs", async (_label, change) => {
    const { doc } = hostDoc();
    DOC.current = doc;
    let release!: () => void;
    const putImage = vi.fn(async (bytes: Uint8Array) => (await new Promise<void>((r) => (release = r)), refOf(bytes)));
    PUT.current = putImage;
    await act(async () => void (mounted = mount(host, { host: { doc, putImage }, principal: ada })));
    await settle();
    const updates = vi.fn();
    doc.on("update", updates);
    await pick(host, picture("x.png", [...PNG]));
    await change();
    await act(async () => release());
    await settle();
    expect(updates).not.toHaveBeenCalled();
    expect(doc.getArray("order").length).toBe(1);
  });

  it("does not save a drag after the editor is gone", async () => {
    vi.useFakeTimers();
    const { deck, doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    const before = JSON.stringify(deck.outline().slides[0]!.elements.map((e) => [e.x, e.y]));
    const box = host.querySelector<HTMLElement>("[aria-label^='Text box 1']")!;
    await act(async () => box.click());
    await act(async () => void host.querySelector("[aria-label^='Text box 1']")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await act(async () => mounted!.unmount());
    mounted = undefined;
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(deck.outline().slides[0]!.elements.map((e) => [e.x, e.y]))).toBe(before);
  });

  it("turns Present off in host mode until onPresent is given", async () => {
    const { doc } = hostDoc();
    await act(async () => void (mounted = mount(host, { host: { doc }, principal: ada })));
    await settle();
    expect(button(host, "Present").disabled).toBe(true);
    const onPresent = vi.fn();
    await act(async () => mounted!.update({ host: { doc }, principal: ada, onPresent }));
    await settle();
    await act(async () => button(host, "Present").click());
    expect(onPresent).toHaveBeenCalledWith(1);
  });

  it("gives another document a new editor, with none of the old state", async () => {
    const a = hostDoc("Deck A");
    const b = hostDoc("Deck B");
    await act(async () => void (mounted = mount(host, { host: { doc: a.doc }, principal: ada })));
    await settle();
    await act(async () => button(host, "Delete slide").click());
    expect(document.body.textContent).toContain("Delete slide 1?");
    await act(async () => mounted!.update({ host: { doc: b.doc }, principal: ada }));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Deck B");
    expect(document.body.textContent).not.toContain("Delete slide 1?");
  });

  it("shows another document on update", async () => {
    const a = hostDoc("Deck A");
    const b = hostDoc("Deck B");
    await act(async () => void (mounted = mount(host, { host: { doc: a.doc }, principal: ada })));
    await settle();
    await act(async () => mounted!.update({ host: { doc: b.doc }, principal: ada }));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Deck B");
  });

  it.each<[string, () => object]>([
    ["a host and a client", () => ({ host: { doc: new Y.Doc() }, client: {} as SlidesClient })],
    ["a host and a presence token", () => ({ host: { doc: new Y.Doc() }, presence: { token: "x" } })],
    ["a host with no document", () => ({ host: {} })],
    ["a host document from another copy of yjs", () => ({ host: { doc: { transact() {}, getMap() {} } } })],
    ["a bad awareness", () => ({ host: { doc: new Y.Doc(), awareness: {} } })],
    ["an awareness with no clientID", () => ({ host: { doc: new Y.Doc(), awareness: { ...fakeAwareness().awareness, clientID: undefined } } })],
    ["a bad putImage", () => ({ host: { doc: new Y.Doc(), putImage: "no" } })],
    ["neither a host nor a client", () => ({})],
    ["a client and no docId", () => ({ client: {} as SlidesClient })],
  ])("throws a TypeError for %s and renders nothing", (_label, make) => {
    expect(() => mount(host, { principal: ada, ...(make() as object) } as never)).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("still needs a principal with a kind in host mode", () => {
    expect(() => mount(host, { host: { doc: new Y.Doc() }, principal: { name: "x" } as never })).toThrow(TypeError);
  });
});
