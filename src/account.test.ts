import { createMemoryBlobs, createMemoryStore, createSharing, type PrincipalContext, type Store, type Subject } from "agentic-identity";
import { describe, expect, it } from "vitest";
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

const exportOf = (store: Store, subject: Subject) => slidesAccount.exportAccount(subject, { store });

describe("slidesAccount", () => {
  it("exports owned decks, grants, and authored records, and no one else's data", async () => {
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

    await expect(decks.outline("duo")).resolves.toMatchObject({ title: "duo" });
    expect((await sharing.can(ctx({ kind: "human", id: "bo" }), "write", "duo")).role).toBe("owner");
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
