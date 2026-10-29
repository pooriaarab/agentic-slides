// @vitest-environment jsdom
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME } from "../src/core/layouts.js";
import type { DeckOutline, SlidesClient } from "../src/client.js";
import { mount, type EmbedPrincipal, type MountedSlides } from "./embed.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no matchMedia, and the theme provider asks for it.
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;

const ada: EmbedPrincipal = { kind: "human", name: "Ada", role: "editor" };
const who = { kind: "human" as const, name: "Ada" };

const outlineOf = (title: string): DeckOutline => ({
  title,
  theme: DEFAULT_THEME,
  editedBy: who,
  machineMade: false,
  slides: [
    { index: 1, id: "s1", layout: "title-body", title: "First", notes: "", createdBy: who, editedBy: who, machineMade: false, elements: [] },
  ],
});

function fakeClient() {
  const outline = vi.fn(async (id: string) => outlineOf(`Deck ${id}`));
  const addSlides = vi.fn(async () => ({ slideIds: ["s2"] }));
  return { client: { outline, addSlides } as unknown as SlidesClient, outline, addSlides };
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const button = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

let host: HTMLElement;
let mounted: MountedSlides | undefined;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(async () => {
  if (mounted) await act(async () => mounted!.unmount());
  mounted = undefined;
  host.remove();
  vi.useRealTimers();
});

describe("mount", () => {
  it.each([
    ["no kind", { name: "Ada" }],
    ["an unknown kind", { kind: "robot", name: "Ada" }],
    ["no name", { kind: "human" }],
    ["a blank name", { kind: "human", name: "  " }],
    ["no principal", undefined],
  ])("throws for %s and renders nothing", (_label, principal) => {
    const { client } = fakeClient();
    expect(() => mount(host, { client, docId: "a", principal: principal as never })).toThrow(TypeError);
    expect(host.innerHTML).toBe("");
  });

  it("renders the deck and lets an editor change it", async () => {
    const { client, outline, addSlides } = fakeClient();
    await act(async () => void (mounted = mount(host, { client, docId: "talk", principal: ada })));
    await settle();
    expect(outline).toHaveBeenCalledWith("talk");
    expect(host.querySelector("h1")?.textContent).toBe("Deck talk");
    expect(button(host, "Add slide").disabled).toBe(false);
    await act(async () => button(host, "Add slide").click());
    expect(addSlides).toHaveBeenCalled();
  });

  it.each([
    ["a viewer", { ...ada, role: "viewer" as const }, false],
    ["a principal with no role", { kind: "human" as const, name: "Ada" }, false],
    ["an editor with readOnly", ada, true],
  ])("opens the deck read only for %s", async (_label, principal, readOnly) => {
    const { client } = fakeClient();
    await act(async () => void (mounted = mount(host, { client, docId: "talk", principal, readOnly })));
    await settle();
    expect(button(host, "Add slide").disabled).toBe(true);
    expect(button(host, "Delete slide").disabled).toBe(true);
  });

  it("calls onPresent with the slide number instead of changing the address", async () => {
    const { client } = fakeClient();
    const onPresent = vi.fn();
    location.hash = "";
    await act(async () => void (mounted = mount(host, { client, docId: "talk", principal: ada, onPresent })));
    await settle();
    await act(async () => button(host, "Present").click());
    expect(onPresent).toHaveBeenCalledWith(1);
    expect(location.hash).toBe("");
  });

  it("joins no live room without a token", async () => {
    const { client } = fakeClient();
    const sockets = vi.fn();
    vi.stubGlobal("WebSocket", class { constructor(...args: unknown[]) { sockets(...args); } });
    try {
      await act(async () => void (mounted = mount(host, { client, docId: "talk", principal: ada })));
      await settle();
      expect(sockets).not.toHaveBeenCalled();
      expect(host.textContent).toContain("Live presence is off");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows another deck on update", async () => {
    const { client } = fakeClient();
    await act(async () => void (mounted = mount(host, { client, docId: "a", principal: ada })));
    await settle();
    await act(async () => mounted!.update({ client, docId: "b", principal: ada }));
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Deck b");
  });

  it("keeps the editor when update gets a bad principal", async () => {
    const { client } = fakeClient();
    await act(async () => void (mounted = mount(host, { client, docId: "a", principal: ada })));
    await settle();
    expect(() => mounted!.update({ client, docId: "b", principal: { name: "x" } as never })).toThrow(TypeError);
    expect(host.querySelector("h1")?.textContent).toBe("Deck a");
  });

  it("removes the editor and stops the poll on unmount", async () => {
    vi.useFakeTimers();
    const { client, outline } = fakeClient();
    await act(async () => void (mounted = mount(host, { client, docId: "a", principal: ada })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
    const calls = outline.mock.calls.length;
    await act(async () => mounted!.unmount());
    mounted = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(host.innerHTML).toBe("");
    expect(outline.mock.calls.length).toBe(calls);
  });

  it("shows the error and a retry when the deck does not load", async () => {
    const { client, outline } = fakeClient();
    outline.mockRejectedValue(new Error("no such deck"));
    await act(async () => void (mounted = mount(host, { client, docId: "gone", principal: ada })));
    await settle();
    expect(host.textContent).toContain("no such deck");
    outline.mockImplementation(async (id: string) => outlineOf(`Deck ${id}`));
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    await settle();
    expect(host.querySelector("h1")?.textContent).toBe("Deck gone");
  });
});
