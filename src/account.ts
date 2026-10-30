// The account plug-in of agentic-slides: a host calls `exportAccount` and `eraseAccount` and never reads the storage layout.
// The shape is the one of the other apps. It is not the `AccountApp` of `agentic-identity/account` (files of one subject). A host that uses `AccountApp` writes a small adapter. It moves to a package contract when identity ships one.
//
// A deck is owned through its sharing record, so the plug-in reads the grants of the subject first. Identity audit rows
// (who changed a grant) belong to `agentic-identity`: the host exports and erases them with its own account step.
import { MAX_OWNERS_ON_ERASE, SUBJECT_KINDS, createSharing, type Json, type Store, type Subject } from "agentic-identity";
import { checkSubject, DECK, principalsOf } from "./access.js";
import { fromBase64, toBase64 } from "./bytes.js";
import { Deck } from "./core/deck.js";
import { fail, readPrincipal } from "./core/principal.js";

const COLLECTION = "decks";
const INDEX = "deck_index";
const PAGE = 100;
/** The name that replaces an erased author. The kind stays, so a record that an agent made stays machine-made. */
export const ERASED_NAME = "erased";

export interface SlidesAccountDeps {
  store: Store;
  /** The sharing resource type. Default: `deck`. */
  resourceType?: string;
  /** The collection of saved Yjs updates. Default: `decks`. */
  collection?: string;
  /** Replaces collection access. The host handles authorship in external decks that stay. */
  contentSource?: SlidesContentSource;
  /**
   * The live rooms (`createLive(env).erase`, as the delete route uses). A room keeps its own copy of the deck and of its authors, so
   * the erase clears the room of each deck that it deletes or changes. Without it, the host clears those rooms itself.
   */
  live?: { erase(deckId: string): Promise<unknown> };
}

/** External content must be JSON. Deletes must be safe to repeat after a partial failure. */
export interface SlidesContentSource {
  exportContent(id: string): Promise<Json>;
  eraseContent(id: string): Promise<unknown>;
}

export type SlidesCollection = "decks" | "grants" | "authored";

export interface SlidesAccount {
  id: "slides";
  /**
   * Collections: `decks` (each deck the subject owns, with its outline), `grants` (each role the subject holds on a deck,
   * the owner role too), and `authored` (each deck, slide, or element in a deck of someone else where the subject is the
   * author or the last editor). With `contentSource`, owned decks have JSON `content` instead of `outline`, and
   * `authored` is empty. The host handles author records in external decks that stay.
   * It holds no format, version, or time: the host's manifest has the time.
   */
  exportAccount(subject: Subject, deps: SlidesAccountDeps): Promise<Record<SlidesCollection, Record<string, Json>[]>>;
  /**
   * Hard deletes each deck where the subject is the only owner, with its sharing records. It removes the other roles of the
   * subject, and it replaces the subject as author in the decks that stay with the name `erased` (the kind stays). Counts by
   * the collection names of the export. `grants` counts each role removed, the owner role of a deleted deck too. A repeat counts zero. Run it with writes stopped. With `deps.live`, it clears the room of each deck that it deletes or changes, and it reads each deck one more time. Without it, the host must do that. Images stay in the blob store: other decks can use the same image.
   * With `contentSource`, erase calls the source only for decks with one owner, then removes the index and sharing
   * records. It does not scan the collection or change authors in external decks. Callback errors reject the call;
   * earlier changes can remain. The source must allow a repeat delete so the host can retry.
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
async function grantsOf(store: Store, subject: Subject, resourceType: string) {
  const found: { docId: string; deckId: string; role: string }[] = [];
  for await (const { id, data } of pages(store, "grants", { subjectKind: subject.kind, subjectId: subject.id })) {
    if (typeof data.resourceId !== "string" || typeof data.role !== "string") continue;
    if ((await store.get<{ type?: string }>("resources", data.resourceId))?.type !== resourceType) continue;
    found.push({ docId: id, deckId: data.resourceId, role: data.role });
  }
  return found;
}

/** The authors of a subject. A subject with a delegated id stands for the delegated token only: a plain `agent` with that name is another principal. */
const authorsOf = (subject: Subject) => {
  const all = principalsOf(subject);
  return all.length > 1 ? all.filter((p) => p.kind !== "agent") : all;
};

/** The subject, checked. The name `erased` is the placeholder of an earlier erase, so no author of a subject has it: not the id, and not the name of a delegated token. */
const subjectOf = (subject: Subject): Subject => {
  const checked = checkSubject(subject);
  return authorsOf(checked).some((p) => p.name === ERASED_NAME) ? fail("INVALID_AUTHOR", `"${ERASED_NAME}" is the placeholder of an erased author, not a subject`) : checked;
};

export const slidesAccount: SlidesAccount = {
  id: "slides",
  async exportAccount(subject, { store, resourceType = DECK, collection = COLLECTION, contentSource }) {
    const who = subjectOf(subject);
    const grants = await grantsOf(store, who, resourceType);
    const owned = new Set(grants.filter((g) => g.role === "owner").map((g) => g.deckId));
    const decks: Record<string, Json>[] = [];
    for (const deckId of [...owned].sort()) {
      if (contentSource) {
        decks.push({ id: deckId, role: "owner", content: await contentSource.exportContent(deckId) });
        continue;
      }
      const saved = await store.get<{ update: string }>(collection, deckId);
      if (saved) decks.push({ id: deckId, role: "owner", outline: Deck.fromUpdate(fromBase64(saved.update)).outline() as unknown as Json });
    }
    const authors = authorsOf(who);
    const authored: unknown[] = [];
    if (!contentSource) for await (const { id, data } of pages(store, collection)) {
      if (owned.has(id) || typeof data.update !== "string") continue;
      for (const record of Deck.fromUpdate(fromBase64(data.update)).authorship(authors)) authored.push({ deckId: id, ...record });
    }
    return {
      decks: plain(decks),
      grants: plain(grants.map(({ deckId, role }) => ({ resourceId: deckId, role }))).sort((a, b) => String(a.resourceId).localeCompare(String(b.resourceId))),
      authored: plain(authored),
    };
  },

  async eraseAccount(subject, { store, live, resourceType = DECK, collection = COLLECTION, contentSource }) {
    const who = subjectOf(subject);
    const sharing = createSharing(store);
    const ctx = { principalId: who.id, kind: who.kind, chain: [{ id: who.id, kind: who.kind }], scopes: [`${resourceType}:admin`] };
    const counts = { decks: 0, grants: 0, authored: 0 };
    for (const { docId, deckId, role } of await grantsOf(store, who, resourceType)) {
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
      if (contentSource) {
        await contentSource.eraseContent(deckId);
        await store.delete(INDEX, deckId);
        counts.decks++;
      } else if (await store.get(collection, deckId)) {
        // The room goes first: it keeps the deck, and a client that is in it could save the deck again.
        await live?.erase(deckId);
        await store.transaction(async (tx) => {
          await tx.delete(collection, deckId);
          await tx.delete(INDEX, deckId);
        });
        counts.decks++;
      }
      await sharing.deleteResource(ctx, deckId);
      // A client that joined the room while the deck went could have filled it again.
      await live?.erase(deckId);
      counts.grants++;
    }
    const authors = authorsOf(who);
    if (!contentSource) for await (const { id } of pages(store, collection)) {
      // One deck at a time in a transaction, so a write from another caller makes it run again.
      // A room that is open can save the old names back, so it goes before the write when this deck has a match.
      const seen = live && (await store.get<{ update: string }>(collection, id));
      if (seen && Deck.fromUpdate(fromBase64(seen.update)).authorship(authors).length > 0) await live!.erase(id);
      const changed = await store.transaction(async (tx) => {
        const saved = await tx.get<{ update: string; title?: string }>(collection, id);
        if (!saved) return 0;
        const deck = Deck.fromUpdate(fromBase64(saved.update));
        const changed = deck.anonymise(authors, ERASED_NAME);
        if (changed === 0) return 0;
        const index = await tx.get<Record<string, Json>>(INDEX, id);
        await tx.put(collection, id, { ...saved, update: toBase64(deck.encode()) });
        if (index) {
          const last = readPrincipal(index.editedBy);
          if (authors.some((p) => p.kind === last.kind && p.name === last.name)) await tx.put(INDEX, id, { ...index, editedBy: { kind: last.kind, name: ERASED_NAME } });
        }
        return changed;
      });
      counts.authored += changed;
      // The room keeps the old names. The next connect loads the saved deck again.
      if (changed > 0) await live?.erase(id);
    }
    return counts;
  },
};
