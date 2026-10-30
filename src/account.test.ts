import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext, type Store, type Subject } from "agentic-identity";
import { describe, expect, it, vi } from "vitest";
import { slidesAccount } from "./account.js";
import { createService } from "./service.js";

const ana: Subject = { kind: "human", id: "ana" };
const ctx = (s: Subject): PrincipalContext => ({ principalId: s.id, kind: s.kind, chain: [{ id: s.id, kind: s.kind }], scopes: ["deck:admin"] });

async function setup() {
  const store = createMemoryStore();
  const sharing = createSharing(store);
  const decks = createService({ store, blobs: createMemoryBlobs() });
  const make = async (id: string, owner: Subject, kind: "human" | "agent" = "human") => {
    await decks.create({ id, title: id, author: { kind, name: owner.id } });
    await sharing.createResource(ctx(owner), { id, type: "deck" });
  };
  return { store, sharing, decks, make };
}

const noAccess: Store = {
  region: "unknown",
  get: async () => { throw new Error("unexpected store access"); },
  query: async () => { throw new Error("unexpected store access"); },
  put: async () => { throw new Error("unexpected store access"); },
  delete: async () => { throw new Error("unexpected store access"); },
  transaction: async () => { throw new Error("unexpected store access"); },
};

const exportOf = (store: Store, subject: Subject) => slidesAccount.exportAccount(subject, { store });

describe("slidesAccount", () => {
  it.each([new Uint8Array([1, 2]), undefined, new Date(), 1n, NaN, { nested: undefined }])("rejects non-JSON external content: %s", async (content) => {
    const { store, make } = await setup();
    await make("room", ana);
    await expect(slidesAccount.exportAccount(ana, {
      store,
      contentSource: { exportContent: async () => content as never, eraseContent: async () => {} },
    })).rejects.toThrow('Content for deck "room" must be JSON');
  });

  it.each(["", null, 42, "deck_index", "grants", "resources", "invites", "share_links", "audit", "links", "principals", "users", "keys", "magic_links", "sessions", "credentials", "handles", "auth_flows", "rate_limits"])("rejects unsafe collections before account access: %s", async (collection) => {
    const { store, make } = await setup();
    await make("mine", ana);
    const before = await exportOf(store, ana);
    const deps = { store: noAccess, collection: collection as never };
    await expect(slidesAccount.exportAccount(ana, deps)).rejects.toThrow("Invalid account collection");
    await expect(slidesAccount.eraseAccount(ana, deps)).rejects.toThrow("Invalid account collection");
    expect(await exportOf(store, ana)).toEqual(before);
  });

  it.each(["", null, 42, "Deck", "deck:admin", "a\n"])("rejects invalid resource types: %s", async (resourceType) => {
    const { store, make } = await setup();
    await make("mine", ana);
    const before = await exportOf(store, ana);
    const deps = { store: noAccess, resourceType: resourceType as never };
    await expect(slidesAccount.exportAccount(ana, deps)).rejects.toThrow("Invalid account resource type");
    await expect(slidesAccount.eraseAccount(ana, deps)).rejects.toThrow("Invalid account resource type");
    expect(await exportOf(store, ana)).toEqual(before);
  });

  it("uses the configured resource type and collection for export and erase", async () => {
    const { store, make } = await setup();
    await make("custom", ana);
    await make("default", ana);
    await store.put("resources", "custom", { type: "presentation" });
    await store.put("presentations", "custom", (await store.get("decks", "custom"))!);
    await store.delete("decks", "custom");
    const deps = { store, resourceType: "presentation", collection: "presentations" };
    const out = await slidesAccount.exportAccount(ana, deps);
    expect(out.decks).toMatchObject([{ id: "custom", outline: { title: "custom" } }]);
    expect(out.grants).toEqual([{ resourceId: "custom", role: "owner" }]);
    expect(await slidesAccount.eraseAccount(ana, deps)).toEqual({ decks: 1, grants: 1, authored: 0 });
    expect(await store.get("presentations", "custom")).toBeNull();
    expect(await store.get("resources", "custom")).toBeNull();
    expect(await store.get("decks", "default")).not.toBeNull();
  });

  it("uses external content without reading or deleting the collection", async () => {
    const { store, make } = await setup();
    await make("room", ana);
    const saved = await store.get("decks", "room");
    const contentSource = {
      exportContent: vi.fn(async () => ({ history: ["slide"] })),
      eraseContent: vi.fn(async () => {}),
    };
    const guarded: Store = {
      ...store,
      get: (collection, id) => {
        if (collection === "decks") throw new Error("collection read");
        return store.get(collection, id);
      },
      query: (collection, query) => {
        if (collection === "decks") throw new Error("collection scan");
        return store.query(collection, query);
      },
    };
    const deps = { store: guarded, contentSource };
    expect((await slidesAccount.exportAccount(ana, deps)).decks).toEqual([
      { id: "room", role: "owner", content: { history: ["slide"] } },
    ]);
    expect(contentSource.exportContent).toHaveBeenCalledWith("room");
    expect(await slidesAccount.eraseAccount(ana, deps)).toEqual({ decks: 1, grants: 1, authored: 0 });
    expect(contentSource.eraseContent).toHaveBeenCalledExactlyOnceWith("room");
    expect(await store.get("decks", "room")).toEqual(saved);
    expect(await store.get("resources", "room")).toBeNull();
  });

  it("keeps external content when another owner remains", async () => {
    const { store, make, sharing } = await setup();
    await make("shared", ana);
    await sharing.grant(ctx(ana), "shared", { kind: "human", id: "bo" }, "owner");
    const contentSource = {
      exportContent: vi.fn(async () => null),
      eraseContent: vi.fn(async () => {}),
    };
    expect(await slidesAccount.eraseAccount(ana, { store, contentSource })).toEqual({ decks: 0, grants: 1, authored: 0 });
    expect(contentSource.eraseContent).not.toHaveBeenCalled();
    expect(await store.get("resources", "shared")).not.toBeNull();
  });

  it("reports external failures and keeps sharing records so erase can resume", async () => {
    const { store, make } = await setup();
    await make("room", ana);
    const contentSource = {
      exportContent: vi.fn(async (): Promise<null> => { throw new Error("history failed"); }),
      eraseContent: vi.fn(async (): Promise<void> => { throw new Error("delete failed"); }),
    };
    await expect(slidesAccount.exportAccount(ana, { store, contentSource })).rejects.toThrow("history failed");
    await expect(slidesAccount.eraseAccount(ana, { store, contentSource })).rejects.toThrow("delete failed");
    expect(await store.get("resources", "room")).not.toBeNull();
    contentSource.eraseContent.mockResolvedValue(undefined);
    expect(await slidesAccount.eraseAccount(ana, { store, contentSource })).toEqual({ decks: 1, grants: 1, authored: 0 });
  });

  it("exports owned decks, grants, and authored records, and no deck of someone else", async () => {
    const { store, sharing, decks, make } = await setup();
    await make("mine", ana);
    await make("theirs", { kind: "human", id: "bo" }, "human");
    await decks.addSlides("mine", { outline: "# Hello\n\nbody", author: { kind: "human", name: "bo" } });
    await sharing.grant(ctx({ kind: "human", id: "bo" }), "theirs", ana, "editor");
    await decks.addSlides("theirs", { outline: "# Mine\n\nbody", author: { kind: "human", name: "ana" } });
    await make("other", { kind: "human", id: "cy" });

    const out = await exportOf(store, ana);

    expect(out.decks.map((d) => d.id)).toEqual(["mine"]);
    expect(out.grants.map((g) => `${g.resourceId}:${g.role}`).sort()).toEqual(["mine:owner", "theirs:editor"]);
    expect(out.authored.every((r) => r.deckId === "theirs")).toBe(true);
    expect(out.authored.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("cy");
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it("erases owned decks, grants, and authorship, and a second erase counts zero", async () => {
    const { store, sharing, decks, make } = await setup();
    await make("mine", ana);
    await make("theirs", { kind: "human", id: "bo" });
    await sharing.grant(ctx({ kind: "human", id: "bo" }), "theirs", ana, "editor");
    await decks.addSlides("theirs", { outline: "# Mine\n\nbody", author: { kind: "human", name: "ana" } });
    const before = await exportOf(store, ana);

    const first = await slidesAccount.eraseAccount(ana, { store });

    expect(first).toEqual({ decks: 1, grants: 2, authored: before.authored.length });
    await expect(decks.outline("mine")).rejects.toMatchObject({ code: "NO_DECK" });
    expect(await store.get("resources", "mine")).toBeNull();
    expect((await sharing.can(ctx(ana), "read", "theirs")).allowed).toBe(false);
    const left = await decks.outline("theirs");
    expect(JSON.stringify(left)).not.toContain('"ana"');
    expect(left.slides[0]!.createdBy).toEqual({ kind: "human", name: "erased" });
    expect((await exportOf(store, ana))).toEqual({ decks: [], grants: [], authored: [] });

    expect(await slidesAccount.eraseAccount(ana, { store })).toEqual({ decks: 0, grants: 0, authored: 0 });
  });

  it("keeps a deck that has another owner and removes only the grant of the subject", async () => {
    const { store, sharing, decks, make } = await setup();
    await make("duo", ana);
    await sharing.grant(ctx(ana), "duo", { kind: "human", id: "bo" }, "owner");

    expect(await slidesAccount.eraseAccount(ana, { store })).toMatchObject({ decks: 0, grants: 1 });

    await expect(decks.outline("duo")).resolves.toMatchObject({ title: "duo", editedBy: { kind: "human", name: "erased" } });
    expect((await sharing.can(ctx({ kind: "human", id: "bo" }), "write", "duo")).role).toBe("owner");
  });

  it("leaves a delegated agent alone when a person is erased, and the reverse", async () => {
    const { store, decks, make } = await setup();
    await make("d", { kind: "human", id: "bo" });
    await decks.addSlides("d", { outline: "# A", author: { kind: "agent_of_human", name: "ana" } });

    expect((await exportOf(store, ana)).authored).toEqual([]);
    expect(await slidesAccount.eraseAccount(ana, { store })).toEqual({ decks: 0, grants: 0, authored: 0 });
    expect((await decks.outline("d")).slides[0]!.createdBy).toEqual({ kind: "agent_of_human", name: "ana" });
  });

  it("keeps a grant on a resource that is not a deck, and the stored bytes lose the name", async () => {
    const { store, sharing, decks, make } = await setup();
    const bo = { ...ctx({ kind: "human", id: "bo" }), scopes: ["sheet:admin"] };
    await sharing.createResource(bo, { id: "sheet", type: "sheet" });
    await sharing.grant(bo, "sheet", ana, "editor");
    await make("d", { kind: "human", id: "bo" });
    await decks.addSlides("d", { outline: "# A", author: { kind: "human", name: "zoeanaxyz" } });
    const zoe: Subject = { kind: "human", id: "zoeanaxyz" };
    const bytes = async () => JSON.stringify(await store.get("decks", "d"));
    const atob64 = (text: string) => Buffer.from(JSON.parse(text).update, "base64").toString("latin1");
    expect(atob64(await bytes())).toContain("zoeanaxyz");

    await slidesAccount.eraseAccount(zoe, { store });
    await slidesAccount.eraseAccount(ana, { store });

    expect(atob64(await bytes())).not.toContain("zoeanaxyz");
    expect((await sharing.can({ ...ctx(ana), scopes: ["sheet:admin"] }, "write", "sheet")).role).toBe("editor");
  });

  it("finishes after a stop between the deck delete and the sharing delete", async () => {
    const { store, sharing, decks, make } = await setup();
    await make("mine", ana);
    const run = store.transaction.bind(store);
    let stopped = false;
    // The first delete of the resource record (the last step of the sharing delete) fails once, as a stop would.
    const stopping: Store = {
      ...store,
      transaction: (fn) =>
        run((tx) =>
          fn({
            ...tx,
            delete: async (collection, id) => {
              if (!stopped && collection === "resources" && id === "mine") {
                stopped = true;
                throw new Error("stop");
              }
              return tx.delete(collection, id);
            },
          }),
        ),
    };

    await expect(slidesAccount.eraseAccount(ana, { store: stopping })).rejects.toThrow();
    await expect(decks.outline("mine")).rejects.toMatchObject({ code: "NO_DECK" });
    expect(await slidesAccount.eraseAccount(ana, { store })).toMatchObject({ decks: 0, grants: 1 });
    expect(await store.get("resources", "mine")).toBeNull();
    expect((await sharing.can(ctx(ana), "read", "mine")).allowed).toBe(false);
  });

  it("treats a delegated subject as the delegated token only", async () => {
    const { store, decks, make } = await setup();
    await make("d", { kind: "human", id: "bo" });
    await decks.addSlides("d", { outline: "# A", author: { kind: "agent", name: "agent_of_human_eve" } });
    const eve: Subject = { kind: "agent", id: "agent_of_human_eve" };

    expect((await exportOf(store, eve)).authored).toEqual([]);
    await slidesAccount.eraseAccount(eve, { store });
    expect((await decks.outline("d")).slides[0]!.createdBy).toEqual({ kind: "agent", name: "agent_of_human_eve" });
  });

  it("clears the live room of each deck that it deletes or changes", async () => {
    const { store, sharing, decks, make } = await setup();
    await make("mine", ana);
    await make("theirs", { kind: "human", id: "bo" });
    await make("untouched", { kind: "human", id: "bo" });
    await sharing.grant(ctx({ kind: "human", id: "bo" }), "theirs", ana, "editor");
    await decks.addSlides("theirs", { outline: "# Mine", author: { kind: "human", name: "ana" } });
    const rooms: string[] = [];

    await slidesAccount.eraseAccount(ana, { store, live: { erase: async (id) => void rooms.push(id) } });

    // A deleted deck: clear, delete, clear. A changed deck: clear before the write and after it.
    expect(rooms.filter((id) => id === "mine")).toHaveLength(2);
    expect(rooms.filter((id) => id === "theirs")).toHaveLength(2);
    expect(rooms).not.toContain("untouched");
  });

  it("refuses the placeholder name as a subject, so an export never shows the records of other erased people", async () => {
    const { store } = await setup();
    const erased: Subject = { kind: "human", id: "erased" };
    await expect(slidesAccount.exportAccount(erased, { store })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
    await expect(slidesAccount.eraseAccount(erased, { store })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
    for (const kind of ["agent_of_human", "agent_of_agent", "user_token"]) {
      const delegated: Subject = { kind: "agent", id: `${kind}_erased` };
      await expect(slidesAccount.exportAccount(delegated, { store })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
      await expect(slidesAccount.eraseAccount(delegated, { store })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
    }
  });

  it("keeps the kind of an erased agent author", async () => {
    const { store, decks, make } = await setup();
    await make("d", { kind: "human", id: "bo" });
    await decks.addSlides("d", { outline: "# A", author: { kind: "agent_of_human", name: "ana" } });
    const agent: Subject = { kind: "agent", id: "agent_of_human_ana" };

    expect((await exportOf(store, agent)).authored.length).toBeGreaterThan(0);
    await slidesAccount.eraseAccount(agent, { store });

    expect((await decks.outline("d")).slides[0]!.createdBy).toEqual({ kind: "agent_of_human", name: "erased" });
  });

  it("refuses a bad subject", async () => {
    const { store } = await setup();
    await expect(slidesAccount.exportAccount({ kind: "human", id: "" }, { store })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
    await expect(slidesAccount.eraseAccount({ kind: "robot" as never, id: "x" }, { store })).rejects.toMatchObject({ code: "INVALID_AUTHOR" });
  });
});
