import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button, EmptyState, FileList, FileRow, Input, useToast } from "agentic-design/react";
import type { DeckSummary, SlidesClient } from "../src/client.js";
import { entryOfPrincipal } from "./principal.js";
import { messageOf } from "./session.js";

export function DeckList({ client, canWrite }: { client: SlidesClient; canWrite: boolean }) {
  const [decks, setDecks] = useState<DeckSummary[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const toast = useToast();

  const load = useCallback(() => {
    setError(undefined);
    client.listDecks().then(setDecks, (e) => setError(messageOf(e)));
  }, [client]);
  useEffect(load, [load]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return setProblem("Type a title for the deck.");
    setBusy(true);
    setProblem(undefined);
    try {
      const { id } = await client.createDeck({ title: title.trim() });
      location.hash = `#/deck/${id}`;
    } catch (e) {
      toast({ title: "The deck was not created", description: messageOf(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1>Decks</h1>
      {canWrite && (
        <form className="create" onSubmit={create} noValidate>
          <Input label="New deck title" value={title} onChange={(e) => setTitle(e.target.value)} error={problem} maxLength={200} />
          <Button type="submit" loading={busy}>Create deck</Button>
        </form>
      )}
      {error ? (
        <EmptyState title="The decks did not load" description={error} action={<Button onClick={load}>Try again</Button>} />
      ) : !decks ? (
        <p role="status" className="muted"><span className="ad-spinner" aria-hidden="true" /> Loading decks…</p>
      ) : decks.length === 0 ? (
        <EmptyState title="No decks yet" description={canWrite ? "Type a title above to make the first deck." : "This token can read decks, and there are none."} />
      ) : (
        <FileList label="Decks">
          {decks.map((deck) => (
            <FileRow key={deck.id} name={deck.title} href={`#/deck/${deck.id}`} modified={new Date(deck.savedAt ?? 0)} editedBy={entryOfPrincipal(deck.editedBy)} />
          ))}
        </FileList>
      )}
    </div>
  );
}
