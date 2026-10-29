import { useEffect, useState } from "react";
import { Button, EmptyState } from "agentic-design/react";
import type { DeckOutline, SlidesClient } from "../src/client.js";
import { messageOf } from "./session.js";
import { SlideView } from "./slide.js";

/** Full-screen present mode. Arrow keys, Page Up, Page Down, and Space move. Home and End jump. Escape leaves. */
export function Present({ client, id, start }: { client: SlidesClient; id: string; start: number }) {
  const [outline, setOutline] = useState<DeckOutline | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [at, setAt] = useState(start - 1);
  // A new number in the address moves the deck.
  useEffect(() => setAt(start - 1), [start]);
  const [attempt, setAttempt] = useState(0);
  const total = outline?.slides.length ?? 0;
  const cur = Math.min(at, Math.max(0, total - 1));

  useEffect(() => {
    setError(undefined);
    client.outline(id).then(setOutline, (e) => setError(messageOf(e)));
  }, [client, id, attempt]);

  const go = (to: number) => setAt(Math.min(Math.max(to, 0), Math.max(0, total - 1)));
  const leave = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    location.hash = `#/deck/${id}`;
  };

  useEffect(() => {
    if (total === 0) return;
    const keys: Record<string, () => void> = {
      ArrowRight: () => go(cur + 1), ArrowDown: () => go(cur + 1), PageDown: () => go(cur + 1), " ": () => go(cur + 1),
      ArrowLeft: () => go(cur - 1), ArrowUp: () => go(cur - 1), PageUp: () => go(cur - 1),
      Home: () => go(0), End: () => go(total - 1), Escape: leave,
    };
    const on = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // A space on a button presses it. The arrows still move the deck.
      if (event.key === " " && target.closest("button, a")) return;
      const run = keys[event.key];
      if (!run || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      run();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  });

  // Keep the position in the address, so a reload opens the same slide.
  useEffect(() => {
    if (total > 0) history.replaceState(null, "", `#/deck/${id}/present/${cur + 1}`);
  }, [cur, id, total]);

  if (error) return <main className="present" data-theme="dark"><EmptyState title="The deck did not load" description={error} action={<><Button onClick={() => setAttempt(attempt + 1)}>Try again</Button> <Button variant="secondary" onClick={leave}>Leave</Button></>} /></main>;
  if (!outline) return <main className="present" data-theme="dark"><p role="status" className="muted"><span className="ad-spinner" aria-hidden="true" /> Loading deck…</p></main>;
  const slide = outline.slides[cur];
  if (!slide) return <main className="present" data-theme="dark"><EmptyState title="This deck has no slides" action={<Button onClick={leave}>Leave</Button>} /></main>;
  return (
    <main className="present" data-theme="dark">
      <div className="present-slide">
        <SlideView slide={slide} theme={outline.theme} label={`Slide ${slide.index} of ${total}: ${slide.title}`} />
        <p className="ad-sr-only" role="status">Slide {slide.index} of {total}: {slide.title}</p>
      </div>
      <div className="present-bar">
        <Button size="sm" variant="secondary" disabled={cur === 0} onClick={() => go(cur - 1)}>Previous</Button>
        <span aria-hidden="true">{slide.index} / {total}</span>
        <Button size="sm" variant="secondary" disabled={cur >= total - 1} onClick={() => go(cur + 1)}>Next</Button>
        <Button size="sm" variant="secondary" onClick={() => void document.documentElement.requestFullscreen?.().catch(() => undefined)}>Full screen</Button>
        <Button size="sm" variant="secondary" onClick={leave}>Leave</Button>
      </div>
    </main>
  );
}
