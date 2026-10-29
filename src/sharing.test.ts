// Decks hold no roles of their own. A host that shares a deck through agentic-identity keys each grant on
// the principal kind and the id, and erases the grants with the deck. These tests pin both, against an
// in-memory Store. The second test shares that Store with a deck service.
import { createMemoryBlobs, createMemoryStore, createSharing, migrateGrants, type PrincipalContext } from "agentic-identity";
import { describe, expect, it } from "vitest";
import { createService } from "./service.js";

const ctx = (id: string, kind: "human" | "agent"): PrincipalContext => ({ principalId: id, kind, chain: [{ id, kind }], scopes: ["deck:admin"] });

describe("sharing with agentic-identity 0.4", () => {
  it("gives a person and an agent with the same id separate roles", async () => {
    const sharing = createSharing(createMemoryStore());
    const owner = ctx("ana", "human");
    await sharing.createResource(owner, { id: "plan", type: "deck" });
    await sharing.grant(owner, "plan", { kind: "human", id: "kit" }, "editor");

    expect((await sharing.can(ctx("kit", "human"), "write", "plan")).role).toBe("editor");
    expect((await sharing.can(ctx("kit", "agent"), "read", "plan")).allowed).toBe(false);

    await sharing.grant(owner, "plan", { kind: "agent", id: "kit" }, "viewer");
    expect((await sharing.can(ctx("kit", "agent"), "write", "plan")).allowed).toBe(false);
    expect((await sharing.can(ctx("kit", "human"), "write", "plan")).role).toBe("editor");
  });

  it("erases the grants with the resource, so a new deck with the same id starts clean", async () => {
    const store = createMemoryStore();
    const sharing = createSharing(store);
    const decks = createService({ store, blobs: createMemoryBlobs() });
    const owner = ctx("ana", "human");
    const { id } = await decks.create({ title: "Plan", id: "plan", author: { kind: "human", name: "ana" } });
    await sharing.createResource(owner, { id, type: "deck" });
    await sharing.grant(owner, id, { kind: "human", id: "kit" }, "editor");
    await sharing.grant(owner, id, { kind: "agent", id: "kit" }, "viewer");
    // The owner grant from `createResource` counts as the first of the three.
    expect((await sharing.listGrants(owner, id)).grants).toHaveLength(3);

    await sharing.deleteResource(owner, id);

    expect((await sharing.can(ctx("kit", "human"), "read", id)).allowed).toBe(false);
    expect((await sharing.can(ctx("kit", "agent"), "read", id)).allowed).toBe(false);
    // The erase touches sharing data only. The deck stays.
    await expect(decks.outline(id)).resolves.toMatchObject({ title: "Plan" });
    await sharing.createResource(ctx("bo", "human"), { id, type: "deck" });
    const grants = (await sharing.listGrants(ctx("bo", "human"), id)).grants;
    expect(grants.map((g) => `${g.subjectKind}:${g.subjectId}:${g.role}`)).toEqual(["human:bo:owner"]);
  });

  it("moves a grant stored under an old key with migrateGrants", async () => {
    const store = createMemoryStore();
    const sharing = createSharing(store);
    // A 0.2 store keyed the owner grant `<resource>:<id>` and had no subject kind.
    await store.put("resources", "plan", { id: "plan", type: "deck" });
    await store.put("principals", "ana", { kind: "human" });
    await store.put("grants", "plan:ana", { resourceId: "plan", subjectId: "ana", role: "owner" });
    expect((await sharing.can(ctx("ana", "human"), "read", "plan")).allowed).toBe(false);

    await expect(migrateGrants(store)).resolves.toEqual({ migrated: 1, unresolved: [] });

    expect((await sharing.can(ctx("ana", "human"), "write", "plan")).role).toBe("owner");
    expect((await sharing.can(ctx("ana", "agent"), "read", "plan")).allowed).toBe(false);
    await expect(migrateGrants(store)).resolves.toEqual({ migrated: 0, unresolved: [] });
  });
});
