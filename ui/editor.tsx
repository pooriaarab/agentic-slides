import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button, Dialog, DialogClose, EmptyState, Input, PlusIcon, PresenceChip, PresenceStack, Select, Textarea, Toolbar, ToolbarButton, ToolbarSeparator, useToast } from "agentic-design/react";
import { COLOR_TOKENS, LAYOUT_NAMES } from "../src/core/layouts.js";
import type { DeckOutline, ElementPatch, SlideOutline } from "../src/client.js";
import { DownIcon, ImageIcon, PlayIcon, RefreshIcon, TrashIcon, UpIcon } from "./icons.js";
import { useAwareness, type AwarenessLike, type DeckApi } from "./host.js";
import { usePresence } from "./presence.js";
import { entryOfPrincipal } from "./principal.js";
import { messageOf } from "./session.js";
import { SLIDE_H, SLIDE_W, SlideView, markup } from "./slide.js";

type El = SlideOutline["elements"][number];
const POLL_MS = 3000;
const clamp = (n: number, low: number, high: number) => Math.round(Math.min(Math.max(n, low), Math.max(low, high)));

export interface EditorProps {
  /** The calls to read and change the deck: a `SlidesClient`, or the calls of a host document. */
  client: DeckApi;
  /** Host mode: starts a watch on the document and gives the call that stops it. The editor reads at each change and does not poll. */
  watch?: (listener: () => void) => () => void;
  /** Host mode: the presence of the host's room. */
  awareness?: AwarenessLike;
  /** The kind of the principal, sent to the host's room. */
  kind?: string;
  /** False when the deck has no place to keep pictures. */
  canImage?: boolean;
  id: string;
  canWrite: boolean;
  name: string;
  /** The bearer token for the live room. Without it, the editor shows no presence. */
  token?: string;
  /** The origin of the Worker for the live room. The default is the origin of the page. */
  origin?: string;
  /** Called with the 1-based slide number when the person picks Present. The default sets the page address. */
  onPresent?: (slide: number) => void;
}

export function Editor({ client, watch, awareness, kind = "human", canImage = true, id, token, origin, canWrite, name, onPresent }: EditorProps) {
  const [outline, setOutline] = useState<DeckOutline | undefined>();
  const [error, setError] = useState<string | undefined>();
  // The slide is kept by id, so a slide that another writer adds or moves does not change which slide is open.
  const [slideId, setSlideId] = useState<string | undefined>();
  const [picked, setPicked] = useState<string | undefined>();
  const [layout, setLayout] = useState("title-body");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pending = useRef(0);
  const latest = useRef(0);
  const toast = useToast();
  const files = useRef<HTMLInputElement>(null);
  const room = usePresence(token, id, name, origin);
  const hostPeers = useAwareness(awareness, { name, kind });
  const peers = awareness ? hostPeers : room.peers;
  const live = awareness ? "live" : room.live;

  const load = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const next = await client.outline(id);
      // A poll that lands while a change is on its way, or an answer that a newer read passed, would undo a change on screen.
      if (pending.current === 0 && mine === latest.current) setOutline(next);
      setError(undefined);
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client, id]);
  useEffect(() => {
    void load();
    // A host document tells the editor when it changes. A client has no such call, so the editor polls.
    if (watch) return watch(() => void load());
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load, watch]);

  const at = Math.max(0, outline?.slides.findIndex((s) => s.id === slideId) ?? 0);
  const slide = outline?.slides[at];
  const element = slide?.elements.find((e) => e.id === picked);

  /** Run one change, tell the person when it fails, and read the deck again. Says whether the change passed. */
  async function act(run: () => Promise<unknown>, failed: string, done?: string): Promise<boolean> {
    pending.current++;
    try {
      await run();
      if (done) toast({ title: done, tone: "success" });
      return true;
    } catch (e) {
      toast({ title: failed, description: messageOf(e), tone: "danger" });
      return false;
    } finally {
      pending.current--;
      await load();
    }
  }

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // A drag that is not saved yet must not write after the editor is gone. With a host document, that write would go to the host's own document.
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  /** Move an element. The screen follows at once. The save waits until the keys or the drag stop. */
  function place(el: El, x: number, y: number, slideId: string) {
    if (!canWrite) return;
    const next = { x: clamp(x, 0, SLIDE_W - el.w), y: clamp(y, 0, SLIDE_H - el.h) };
    setOutline((o) => o && { ...o, slides: o.slides.map((s) => (s.id !== slideId ? s : { ...s, elements: s.elements.map((e) => (e.id === el.id ? { ...e, ...next } : e)) })) });
    const waiting = timers.current.has(el.id);
    clearTimeout(timers.current.get(el.id));
    if (!waiting) pending.current++;
    timers.current.set(
      el.id,
      setTimeout(() => {
        timers.current.delete(el.id);
        void act(() => client.editElement(id, slideId, el.id, next), "The element did not move").finally(() => {
          pending.current--;
          void load();
        });
      }, 350),
    );
  }

  const patchElement = (el: El, patch: ElementPatch, done?: string): Promise<boolean> => act(() => client.editElement(id, slide!.id, el.id, patch), "The change was not saved", done);
  const add = (name: string) => act(async () => {
    const { slideIds } = await client.addSlides(id, { layout: name, at: slide ? at + 2 : undefined });
    setOutline(await client.outline(id));
    setSlideId(slideIds[0]);
    setPicked(undefined);
  }, "The slide was not added", "Slide added");
  const move = (by: number) => slide && act(async () => {
    await client.moveSlide(id, slide.id, slide.index + by);
  }, "The slide did not move");
  const [doomed, setDoomed] = useState("");
  const remove = () => doomed && act(async () => {
    await client.deleteSlide(id, doomed);
    setSlideId(outline?.slides[Math.max(0, at - 1)]?.id);
    setPicked(undefined);
  }, "The slide was not deleted", "Slide deleted");

  async function addImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[^\w -]/g, " ").trim() || "Image";
    await act(async () => {
      const { slideIds } = await client.addSlides(id, { outline: `layout: image-right\n# ${title}\n![${title}](picture)`, images: { picture: new Uint8Array(await file.arrayBuffer()) }, at: slide ? at + 2 : undefined });
      setOutline(await client.outline(id));
      setSlideId(slideIds[0]);
    }, "The image slide was not added", "Image slide added");
  }

  const present = `#/deck/${id}/present/${slide?.index ?? 1}`;

  if (error && !outline) return <div className="page"><EmptyState title="The deck did not load" description={error} action={<Button onClick={() => void load()}>Try again</Button>} /></div>;
  if (!outline) return <div className="page"><p role="status" className="muted"><span className="agd-spinner" aria-hidden="true" /> Loading deck…</p></div>;

  return (
    <div className="editor">
      <div className="editor-head">
        <h1>{outline.title}</h1>
        <div className="head-meta">
          <PresenceStack entries={peers} label="Here now" />
          <span className="muted" role="status">{live === "live" ? (watch ? "Presence on" : "Live") : live === "connecting" ? "Connecting…" : "Live presence is off"}</span>
        </div>
      </div>
      {error && <p role="alert" className="banner">The deck could not refresh: {error}</p>}
      <Toolbar label="Slide tools">
        <ToolbarButton label="Add slide" icon={<PlusIcon />} disabled={!canWrite} onClick={() => void add(layout)} />
        <ToolbarButton label="Add image slide" icon={<ImageIcon />} disabled={!canWrite || !canImage} onClick={() => files.current?.click()} />
        <ToolbarSeparator />
        <ToolbarButton label="Move slide earlier" icon={<UpIcon />} disabled={!canWrite || !slide || slide.index === 1} onClick={() => void move(-1)} />
        <ToolbarButton label="Move slide later" icon={<DownIcon />} disabled={!canWrite || !slide || slide.index === outline.slides.length} onClick={() => void move(1)} />
        <ToolbarButton label="Delete slide" icon={<TrashIcon />} disabled={!canWrite || !slide} onClick={() => (setDoomed(slide!.id), setConfirmDelete(true))} />
        <ToolbarSeparator />
        <ToolbarButton label="Refresh" icon={<RefreshIcon />} onClick={() => void load()} />
        <ToolbarButton label="Present" icon={<PlayIcon />} disabled={!slide || (!!watch && !onPresent)} onClick={() => (onPresent ? onPresent(slide?.index ?? 1) : (location.hash = present))} />
      </Toolbar>
      <input ref={files} type="file" accept="image/png,image/jpeg" hidden onChange={addImage} aria-label="Image file" tabIndex={-1} />
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete} title={`Delete slide ${outline.slides.find((s) => s.id === doomed)?.index ?? ""}?`} description={`"${outline.slides.find((s) => s.id === doomed)?.title || "Untitled"}" and its notes are removed from the deck.`} footer={<><DialogClose asChild><Button variant="secondary">Keep slide</Button></DialogClose><DialogClose asChild><Button variant="danger" onClick={() => void remove()}>Delete slide</Button></DialogClose></>} />

      {!slide ? (
        <EmptyState title="This deck has no slides" description={canWrite ? "Add the first slide." : "Nothing to show."} action={canWrite ? <Button onClick={() => void add(layout)}>Add first slide</Button> : undefined} />
      ) : (
        <div className="workspace">
          <nav aria-label="Slide sorter" className="sorter">
            <ol>
              {outline.slides.map((s, i) => (
                <li key={s.id}>
                  <button type="button" className="thumb" aria-current={i === at ? "true" : undefined} onClick={() => (setSlideId(s.id), setPicked(undefined))}>
                    <span className="thumb-box"><SlideView slide={s} theme={outline.theme} label="" /></span>
                    <span className="thumb-text"><span className="thumb-number"><span className="agd-sr-only">Slide </span>{s.index}</span> <span className="thumb-title">{s.title || "Untitled"}</span></span>
                    {s.machineMade && <span className="agent-mark">Agent edit</span>}
                  </button>
                </li>
              ))}
            </ol>
          </nav>
          <section aria-label="Slide canvas" className="stage">
            <SlideView slide={slide} theme={outline.theme} selected={picked} onSelect={setPicked} onNudge={(el, x, y) => place(el, x, y, slide.id)} label={`Slide ${slide.index} canvas. Pick an element, then use the arrow keys to move it.`} />
            <p className="muted hint">Pick an element, then drag it or use the arrow keys. Shift makes the step small.</p>
          </section>
          <aside aria-label="Properties" className="props">
            <h2>{element ? "Element" : `Slide ${slide.index}`}</h2>
            <p className="who">Last edit: <PresenceChip entry={entryOfPrincipal(element ? element.editedBy : slide.editedBy)} /></p>
            {(element ? element.machineMade : slide.machineMade) && <p className="agent-mark">Edited by an agent</p>}
            {element ? <ElementForm key={element.id} el={element} canWrite={canWrite} save={(patch, done) => patchElement(element, patch, done)} /> : (
              <>
                <p className="muted">Layout: {slide.layout}. Pick an element on the canvas to edit it.</p>
                {slide.notes && <p><strong>Notes:</strong> {slide.notes}</p>}
                <Select label="Layout for new slides" value={layout} onChange={(e) => setLayout(e.target.value)} disabled={!canWrite}>
                  {LAYOUT_NAMES.map((n) => <option key={n}>{n}</option>)}
                </Select>
              </>
            )}
          </aside>
        </div>
      )}
      {!canWrite && <p className="muted">This token can read decks. It cannot change them.</p>}
    </div>
  );
}

function ElementForm({ el, canWrite, save }: { el: El; canWrite: boolean; save: (patch: ElementPatch, done?: string) => Promise<boolean> }) {
  // A draft is what the person typed and did not save. Without one, the field follows the deck, so an agent's edit shows.
  const [text, setText] = useState<string | undefined>();
  const [alt, setAlt] = useState<string | undefined>();
  // The fields keep the typed text, so an empty field is not the number 0.
  const [edited, setEdited] = useState<Partial<Record<"x" | "y" | "w" | "h", string>>>({});
  const shown = { x: String(el.x), y: String(el.y), w: String(el.w), h: String(el.h), ...edited };
  const bad = (key: keyof typeof shown) => !/^-?\d+$/.test(shown[key].trim());
  const num = (key: keyof typeof shown) => (
    <Input key={key} label={key.toUpperCase()} type="number" value={shown[key]} disabled={!canWrite} error={bad(key) ? "Type a whole number." : undefined} onChange={(e) => setEdited({ ...edited, [key]: e.target.value })} />
  );
  return (
    <form className="element-form" onSubmit={(e) => { e.preventDefault(); }}>
      {el.kind === "text" && (
        <>
          <Textarea label="Text" hint="Use **bold** and *italic*." rows={5} value={text ?? markup(el.runs)} disabled={!canWrite} onChange={(e) => setText(e.target.value)} />
          <Button disabled={!canWrite} onClick={() => void save({ text: text ?? markup(el.runs) }, "Text saved").then((ok) => ok && setText(undefined))}>Save text</Button>
        </>
      )}
      {el.kind === "shape" && (
        <Select label="Fill" value={el.fill} disabled={!canWrite} onChange={(e) => void save({ fill: e.target.value as never }, "Fill saved")}>
          {COLOR_TOKENS.map((c) => <option key={c}>{c}</option>)}
        </Select>
      )}
      {el.kind === "image" && (
        <>
          <Input label="Description" hint="Say what the picture shows." value={alt ?? el.alt} disabled={!canWrite} onChange={(e) => setAlt(e.target.value)} />
          <Button disabled={!canWrite} onClick={() => void save({ alt: alt ?? el.alt }, "Description saved").then((ok) => ok && setAlt(undefined))}>Save description</Button>
        </>
      )}
      <fieldset className="box">
        <legend>Position and size</legend>
        {num("x")}{num("y")}{num("w")}{num("h")}
        <Button variant="secondary" disabled={!canWrite || (["x", "y", "w", "h"] as const).some(bad)} onClick={() => void save({ x: Number(shown.x), y: Number(shown.y), w: Number(shown.w), h: Number(shown.h) }, "Position saved").then((ok) => ok && setEdited({}))}>Save position</Button>
      </fieldset>
    </form>
  );
}
