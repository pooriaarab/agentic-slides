import type { DeckOutline } from "../core/deck.js";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "../core/layouts.js";
import { esc, renderPage, renderSlide, themeCss, type RenderOptions } from "./html.js";

// Keys: arrows, PageUp/PageDown, Space, Backspace move. Home and End jump.
// N shows the speaker notes. F toggles full screen. The slide number lives in the hash.
const SCRIPT = `(function(){var d=document,slides=[].slice.call(d.querySelectorAll(".slide")),notes=[].slice.call(d.querySelectorAll("[data-notes-for]")),stage=d.getElementById("stage"),deck=d.getElementById("deck"),status=d.getElementById("status"),origin=d.getElementById("origin"),panel=d.getElementById("notes"),text=d.getElementById("notes-text"),toggle=d.getElementById("toggle-notes"),i=0;
function fit(){var w=stage.clientWidth,h=stage.clientHeight;if(w&&h)deck.style.transform="translate(-50%,-50%) scale("+Math.min(w/${SLIDE_WIDTH},h/${SLIDE_HEIGHT})+")"}
function show(n){if(!slides.length){status.textContent="No slides";return}i=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,k){s.hidden=k!==i});status.textContent=(i+1)+" / "+slides.length;origin.textContent=slides[i].getAttribute("data-machine-made")==="true"?"Made or edited by an agent":"";text.textContent=notes[i]?notes[i].textContent:"";if(location.hash!=="#"+(i+1))history.replaceState(null,"","#"+(i+1))}
function notesView(on){panel.hidden=!on;d.body.classList.toggle("with-notes",on);toggle.setAttribute("aria-pressed",String(on));fit()}
var keys={ArrowRight:1,ArrowDown:1,PageDown:1," ":1,ArrowLeft:-1,ArrowUp:-1,PageUp:-1,Backspace:-1};
d.addEventListener("keydown",function(e){if(e.ctrlKey||e.metaKey||e.altKey)return;var k=e.key;if((k===" "||k==="Enter")&&e.target&&e.target.closest&&e.target.closest("button"))return;
if(Object.prototype.hasOwnProperty.call(keys,k))show(i+keys[k]);else if(k==="Home")show(0);else if(k==="End")show(slides.length-1);else if(k==="n"||k==="N")notesView(panel.hidden);else if(k==="f"||k==="F"){if(d.fullscreenElement)d.exitFullscreen();else if(d.documentElement.requestFullscreen)d.documentElement.requestFullscreen()}else return;e.preventDefault()});
d.getElementById("prev").onclick=function(){show(i-1)};d.getElementById("next").onclick=function(){show(i+1)};toggle.onclick=function(){notesView(panel.hidden)};
window.addEventListener("resize",fit);
var start=parseInt(location.hash.slice(1),10);show(isNaN(start)?0:start-1);fit()})();`;

const CHROME_CSS = `
body{margin:0;background:#111;color:#fff;font:16px system-ui,sans-serif}
#stage{position:fixed;inset:0 0 56px 0;overflow:hidden}
#deck{position:absolute;left:50%;top:50%;width:${SLIDE_WIDTH}px;height:${SLIDE_HEIGHT}px;transform-origin:center}
.slide[hidden]{display:none}
#notes{position:fixed;left:0;right:0;bottom:56px;height:max(120px,24vh);overflow:auto;box-sizing:border-box;padding:12px 24px;background:#1f2328;border-top:1px solid #6e7681}
#notes[hidden]{display:none}
#notes h2{margin:0 0 8px;font-size:16px}#notes-text{white-space:pre-wrap;font-size:20px}
body.with-notes #stage{bottom:calc(56px + max(120px,24vh))}
.controls{position:fixed;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;justify-content:center;gap:16px;background:#000}
.controls button{min-width:44px;min-height:44px;font:inherit;color:#fff;background:#30363d;border:1px solid #8b949e;border-radius:6px;cursor:pointer}
.controls button[aria-pressed="true"]{background:#0b5cad}
button:focus-visible{outline:3px solid #ffbf47;outline-offset:2px}
#origin{color:#ffd479}`;

/** A page that presents the deck: one slide at a time, keyboard navigation, and a speaker-notes view. */
export function renderPresent(outline: DeckOutline, options: RenderOptions = {}): string {
  const total = outline.slides.length;
  const slides = outline.slides.map((s, i) => renderSlide(s, outline.theme, options, total, i > 0)).join("\n");
  const notes = outline.slides.map((s) => `<div data-notes-for="${s.index}">${esc(s.notes)}</div>`).join("");
  const body = `<body>
<main id="stage" aria-label="${esc(outline.title)}"><div id="deck">${slides}</div></main>
<aside id="notes" aria-label="Speaker notes" hidden><h2>Speaker notes</h2><div id="notes-text"></div></aside>
<div id="notes-store" hidden>${notes}</div>
<nav class="controls" aria-label="Presentation controls"><button id="prev" type="button" aria-label="Previous slide">&#8249;</button><span id="status" role="status" aria-live="polite"></span><button id="next" type="button" aria-label="Next slide">&#8250;</button><button id="toggle-notes" type="button" aria-pressed="false" aria-keyshortcuts="n">Notes</button><span id="origin" role="status"></span></nav>
<script>${SCRIPT}</script>
</body>`;
  return renderPage(outline, `${themeCss(outline.theme)}${CHROME_CSS}`, body, options);
}
