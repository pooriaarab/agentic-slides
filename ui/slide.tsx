import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";
import type { Run } from "../src/core/model.js";
import type { DeckOutline, SlideOutline } from "../src/client.js";

export const SLIDE_W = 1280;
export const SLIDE_H = 720;

type Theme = DeckOutline["theme"];
type El = SlideOutline["elements"][number];

/** Split runs at each newline, so each paragraph is one list of runs. */
function paragraphs(runs: Run[]): Run[][] {
  const out: Run[][] = [[]];
  for (const run of runs) {
    run.text.split("\n").forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part) out[out.length - 1]!.push({ ...run, text: part });
    });
  }
  return out;
}

/** Runs as text with `**bold**` and `*italic*` marks, the form that an edit sends back. */
export const markup = (runs: Run[]): string => runs.map((r) => (r.bold ? `**${r.text}**` : r.italic ? `*${r.text}*` : r.text)).join("");

export const describe = (el: El, index: number): string => {
  const place = `${el.kind === "text" ? "Text box" : el.kind === "shape" ? "Shape" : el.kind === "image" ? "Image" : "Table"} ${index + 1}`;
  if (el.kind === "text") return `${place}: ${el.runs.map((r) => r.text).join("").replace(/\s+/g, " ").trim()}`;
  if (el.kind === "image") return `${place}: ${el.alt || "no description"}`;
  return place;
};

const box = (el: El, drag?: { x: number; y: number }): CSSProperties => ({
  left: `${((drag?.x ?? el.x) / SLIDE_W) * 100}%`,
  top: `${((drag?.y ?? el.y) / SLIDE_H) * 100}%`,
  width: `${(el.w / SLIDE_W) * 100}%`,
  height: `${(el.h / SLIDE_H) * 100}%`,
});

function Body({ el, theme }: { el: El; theme: Theme }) {
  if (el.kind === "text") {
    const lines = paragraphs(el.runs);
    // A space between lines keeps the text that a reader gets in step with the name of the element.
    const items = lines.flatMap((runs, i) => [
      i > 0 && " ",
      <span key={i} className="slide-line">
        {runs.map((r, j) => (r.bold ? <strong key={j}>{r.text}</strong> : r.italic ? <em key={j}>{r.text}</em> : r.text))}
      </span>,
    ]);
    return <div className={`slide-text${el.list ? " slide-list" : ""}`} style={{ color: theme.colors[el.color], fontSize: `${el.fontSize / (SLIDE_W / 100)}cqw`, fontFamily: el.slot === "title" ? theme.fonts.heading : theme.fonts.body }}>{items}</div>;
  }
  if (el.kind === "shape") return <div className={`slide-shape slide-${el.shape}`} style={{ background: theme.colors[el.fill] }} />;
  if (el.kind === "image") return <div className="slide-image">{el.alt || "Image"}</div>;
  return (
    <table className="slide-table" style={{ color: theme.colors.text, fontSize: `${22 / (SLIDE_W / 100)}cqw` }}>
      <tbody>{el.rows.map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody>
    </table>
  );
}

export interface SlideViewProps {
  slide: SlideOutline;
  theme: Theme;
  /** With a handler, each element is a button that can be picked, moved with the arrow keys, and dragged. */
  selected?: string;
  onSelect?: (id: string) => void;
  onNudge?: (el: El, x: number, y: number) => void;
  /** The accessible name. An empty text hides the slide from assistive technology, for a thumbnail with a name beside it. */
  label?: string;
}

/** One slide in the 1280 by 720 space. It scales with its container. */
export function SlideView({ slide, theme, selected, onSelect, onNudge, label }: SlideViewProps) {
  const interactive = onSelect !== undefined;
  const key = (el: El) => (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect?.(el.id);
    }
    const step = event.shiftKey ? 1 : 10;
    const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const by = move[event.key];
    if (by && selected === el.id) {
      event.preventDefault();
      onNudge?.(el, el.x + by[0], el.y + by[1]);
    }
  };
  const drag = (el: El) => (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !onNudge) return;
    onSelect?.(el.id);
    const scale = SLIDE_W / (event.currentTarget.parentElement!.getBoundingClientRect().width || SLIDE_W);
    const from = { x: event.clientX, y: event.clientY };
    let moved = false;
    const move = (e: globalThis.PointerEvent) => {
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) moved = true;
    };
    const stop = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", stop);
    };
    const up = (end: globalThis.PointerEvent) => {
      stop();
      if (moved) onNudge(el, el.x + (end.clientX - from.x) * scale, el.y + (end.clientY - from.y) * scale);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", stop);
  };
  return (
    <div className="slide" data-theme="light" {...(label === "" ? { "aria-hidden": true } : { role: interactive ? "group" : "img", "aria-label": label ?? `Slide ${slide.index}: ${slide.title}` })} style={{ background: theme.colors.background }}>
      {slide.elements.map((el, i) =>
        interactive ? (
          <div
            key={el.id}
            className={`slide-el${selected === el.id ? " is-selected" : ""}${el.machineMade ? " is-agent" : ""}`}
            style={box(el)}
            role="button"
            tabIndex={0}
            aria-pressed={selected === el.id}
            aria-label={`${describe(el, i)}${el.machineMade ? ", Agent edit" : ""}`}
            onClick={() => onSelect(el.id)}
            onKeyDown={key(el)}
            onPointerDown={drag(el)}
          >
            <Body el={el} theme={theme} />
          </div>
        ) : (
          <div key={el.id} className="slide-el" style={box(el)} aria-hidden="true">
            <Body el={el} theme={theme} />
          </div>
        ),
      )}
    </div>
  );
}
