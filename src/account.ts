// The account plug-in of agentic-slides: a host calls `exportAccount` and `eraseAccount` and never reads the storage layout.
// The shape is the one of the other apps. It is not the `AccountApp` of `agentic-identity/account` (files of one subject). A host that uses `AccountApp` writes a small adapter. It moves to a package contract when identity ships one.
//
// A deck is owned through its sharing record, so the plug-in reads the grants of the subject first. Identity audit rows
// (who changed a grant) belong to `agentic-identity`: the host exports and erases them with its own account step.
import { MAX_OWNERS_ON_ERASE, SUBJECT_KINDS, createSharing, type Json, type Store, type Subject } from "agentic-identity";
import { checkSubject, DECK, principalsOf } from "./access.js";
import { fromBase64, toBase64 } from "./bytes.js";
import { Deck } from "./core/deck.js";
import { readPrincipal } from "./core/principal.js";

const COLLECTION = "decks";
const INDEX = "deck_index";
const PAGE = 100;
/** The name that replaces an erased author. The kind stays, so a record that an agent made stays machine-made. */
export const ERASED_NAME = "erased";

export interface SlidesAccountDeps {
  store: Store;
}

export type SlidesCollection = "decks" | "grants" | "authored";

export interface SlidesAccount {
  id: "slides";
  /**
   * Collections: `decks` (each deck the subject owns, with its outline), `grants` (each role the subject holds on a deck,
   * the owner role too), and `authored` (each deck, slide, or element in a deck of someone else where the subject is the
   * author or the last editor). It holds no format, version, or time: the host's manifest has the time.
   */
  exportAccount(subject: Subject, deps: SlidesAccountDeps): Promise<Record<SlidesCollection, Record<string, Json>[]>>;
  /**
   * Hard deletes each deck where the subject is the only owner, with its sharing records. It removes the other roles of the
   * subject, and it replaces the subject as author in the decks that stay with the name `erased` (the kind stays). Counts by
   * the collection names of the export. A repeat counts zero. Run it with writes stopped, and clear live rooms in the host:
   * the plug-in does not reach them. Images stay in the blob store: other decks can use the same image.
   */
  eraseAccount(subject: Subject, deps: SlidesAccountDeps): Promise<Record<SlidesCollection, number>>;
}

// Through JSON, so the records are what a file would hold: a key with no value is dropped, not left as `undefined`.
const plain = (value: unknown): Record<string, Json>[] => JSON.parse(JSON.stringify(value)) as Record<string, Json>[];

async function* pages(store: Store, collection: string, where?: Record<string, string>) {
  for (let cursor: string | undefined; ; ) {
    const page = await store.query<Record<string, Json>>(collection, { ...(where ? { where } : {}), limit: PAGE, ...(cursor === undefined ? {} : { cursor }) });
    for (const item of page.items) yield item;
    if ((cursor = page.nextCursor) === undefined) return;
  }
}

/** The grants of the subject on decks: the doc id, the deck id, and the role. A grant on another kind of resource is not ours. */
async function grantsOf(store: Store, subject: Subject) {
  const found: { docId: string; deckId: string; role: string }[] = [];
  for await (const { id, data } of pages(store, "grants", { subjectKind: subject.kind, subjectId: subject.id })) {
    if (typeof data.resourceId !== "string" || typeof data.role !== "string") continue;
    if ((await store.get<{ type?: string }>("resources", data.resourceId))?.type !== DECK) continue;
    found.push({ docId: id, deckId: data.resourceId, role: data.role });
  }
  return found;
}

export const slidesAccount: SlidesAccount = {
  id: "slides",
  async exportAccount(subject, { store }) {
    const who = checkSubject(subject);
    const grants = await grantsOf(store, who);
    const owned = new Set(grants.filter((g) => g.role === "owner").map((g) => g.deckId));
    const decks: Record<string, Json>[] = [];
    for (const deckId of [...owned].sort()) {
      const saved = await store.get<{ update: string }>(COLLECTION, deckId);
      if (saved) decks.push({ id: deckId, role: "owner", outline: Deck.fromUpdate(fromBase64(saved.update)).outline() as unknown as Json });
    }
    const authors = principalsOf(who);
    const authored: unknown[] = [];
    for await (const { id, data } of pages(store, COLLECTION)) {
      if (owned.has(id) || typeof data.update !== "string") continue;
      for (const record of Deck.fromUpdate(fromBase64(data.update)).authorship(authors)) authored.push({ deckId: id, ...record });
    }
    return {
      decks: plain(decks),
      grants: plain(grants.map(({ deckId, role }) => ({ resourceId: deckId, role }))).sort((a, b) => String(a.resourceId).localeCompare(String(b.resourceId))),
      authored: plain(authored),
    };
  },

  async eraseAccount(subject, { store }) {
    const who = checkSubject(subject);
    const sharing = createSharing(store);
    const ctx = { principalId: who.id, kind: who.kind, chain: [{ id: who.id, kind: who.kind }], scopes: [`${DECK}:admin`] };
    const counts = { decks: 0, grants: 0, authored: 0 };
    for (const { docId, deckId, role } of await grantsOf(store, who)) {
      if (role !== "owner") {
        await store.delete("grants", docId);
        counts.grants++;
        continue;
      }
      const owners = await store.query("grants", { where: { resourceId: deckId, role: "owner" }, limit: MAX_OWNERS_ON_ERASE + 1 });
      // Count the owners that identity counts: a grant with no known subject kind (not migrated) is not an owner.
      if (owners.items.some((o) => o.id !== docId && (SUBJECT_KINDS as readonly unknown[]).includes(o.data.subjectKind))) {
        await sharing.revokeGrant(ctx, deckId, who);
        counts.grants++;
        continue;
      }
      // The deck goes first. A stop leaves the owner record, and the next run finds it and goes on.
      if (await store.get(COLLECTION, deckId)) {
        await store.transaction(async (tx) => {
          await tx.delete(COLLECTION, deckId);
          await tx.delete(INDEX, deckId);
        });
        counts.decks++;
      }
      await sharing.deleteResource(ctx, deckId);
      counts.grants++;
    }
    const authors = principalsOf(who);
    for await (const { id } of pages(store, COLLECTION)) {
      // One deck at a time in a transaction, so a write from another caller makes it run again.
      counts.authored += await store.transaction(async (tx) => {
        const saved = await tx.get<{ update: string; title?: string }>(COLLECTION, id);
        if (!saved) return 0;
        const deck = Deck.fromUpdate(fromBase64(saved.update));
        const changed = deck.anonymise(authors, ERASED_NAME);
        if (changed === 0) return 0;
        const index = await tx.get<Record<string, Json>>(INDEX, id);
        await tx.put(COLLECTION, id, { ...saved, update: toBase64(deck.encode()) });
        if (index) {
          const last = readPrincipal(index.editedBy);
          if (authors.some((p) => p.kind === last.kind && p.name === last.name)) await tx.put(INDEX, id, { ...index, editedBy: { kind: last.kind, name: ERASED_NAME } });
        }
        return changed;
      });
    }
    return counts;
  },
};
