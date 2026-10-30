// The editor for an app that embeds it: `agentic-slides/ui`. The app gives a deck id, a client, and the principal who uses
// the editor. The web UI that the Worker serves renders the same component. React and react-dom are peer dependencies.
import { StrictMode, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import "./app.css";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/core/principal.js";
import type { SlidesClient } from "../src/client.js";
import { Editor } from "./editor.js";
import { checkHost, hostApi, watchDoc, type AwarenessLike, type DeckHost } from "./host.js";

export type { SlidesClient, DeckHost, AwarenessLike };

/** Who uses the editor. The server still checks every write against its own token. */
export interface EmbedPrincipal {
  kind: PrincipalKind;
  name: string;
  /** Only `editor` can change the deck. Any other value, or no value, opens it read only. */
  role?: "editor" | "viewer";
}

interface CommonOptions {
  principal: EmbedPrincipal;
  /** Force read only, even for an editor. */
  readOnly?: boolean;
  /** Called with the 1-based slide number when the person picks Present. The default sets the page address. With `host`, Present is off until you give this. */
  onPresent?: (slide: number) => void;
}

/** Client mode: the editor reads and writes through an HTTP client. */
export interface ClientOptions extends CommonOptions {
  /** A client from `createClient` in `agentic-slides/client`. */
  client: SlidesClient;
  host?: never;
  /** The deck id. */
  docId: string;
  /** The live room for presence. Give the bearer token, and the origin when it is not the page origin. Without it, the editor shows no presence. */
  presence?: { token: string; origin?: string };
}

/** Host mode: the editor reads and writes a Yjs document of your own. It makes no HTTP call, and it never polls: it reads again at each change of the document. It does not close the document or the awareness. */
export interface HostOptions extends CommonOptions {
  host: DeckHost;
  client?: never;
  presence?: never;
  /** The default is "host". */
  docId?: string;
}

export type SlidesEditorOptions = ClientOptions | HostOptions;

/** A principal must have a known kind and a name. A missing kind is an error, never a default. */
function checkPrincipal(principal: EmbedPrincipal): void {
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.name !== "string" || principal.name.trim() === "") {
    throw new TypeError(`the editor needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  }
}

/** Exactly one source: a client, or a host document. Throws a TypeError before anything renders. */
function checkOptions(options: SlidesEditorOptions): void {
  checkPrincipal(options.principal);
  if (options.host) {
    checkHost(options.host);
    if ((options as { client?: unknown }).client || (options as { presence?: unknown }).presence) throw new TypeError("with host, give no client and no presence: the host document and awareness do that");
  } else if (!options.client || typeof options.docId !== "string" || options.docId === "") {
    throw new TypeError("the editor needs a client and a docId, or a host");
  }
}

/** The editor for one deck. It needs the theme, tooltip, and toast providers above it. `mount` adds them. */
export function SlidesEditor(options: SlidesEditorOptions) {
  checkOptions(options);
  const { client, host, docId, principal, readOnly, presence, onPresent } = options;
  const { name, kind } = principal;
  // `api` and `watch` read only the document and the image store, so those are the only dependencies.
  // A host mode source is built once per document, principal, and image store, so the editor does not read again on each render.
  const canWrite = principal.role === "editor" && !readOnly;
  const api = useMemo(() => (host ? hostApi(host, { kind, name }) : undefined), [host?.doc, host?.putImage, kind, name, canWrite]);
  // StrictMode runs each effect twice, so the effect starts the api again.
  useEffect(() => (api?.start(), () => api?.stop()), [api]);
  const watch = useMemo(() => (host ? (listener: () => void) => watchDoc(host.doc, listener) : undefined), [host?.doc]);
  if (host) return <Editor key={keyOf(options)} client={api!} watch={watch} awareness={host.awareness} kind={kind} canImage={!!host.putImage} id={docId ?? "host"} name={name} canWrite={canWrite} onPresent={onPresent} />;
  return <Editor client={client!} id={docId!} name={name} canWrite={canWrite} token={presence?.token} origin={presence?.origin} onPresent={onPresent} />;
}

export interface MountedSlides {
  /** Show another deck or principal in the same place. A bad principal throws and keeps the editor as it is. */
  update(options: SlidesEditorOptions): void;
  /** Remove the editor and stop its timers and live connection. */
  unmount(): void;
}

/** One number for each host document, so a new document gets a new editor and none of the old state. */
const docKeys = new WeakMap<object, number>();
let docCount = 0;
const keyOf = (options: SlidesEditorOptions): string => {
  if (!options.host) return options.docId;
  if (!docKeys.has(options.host.doc)) docKeys.set(options.host.doc, ++docCount);
  return `host-${docKeys.get(options.host.doc)}`;
};

/** Render the editor into an element, for an app that does not use React itself. */
export function mount(element: HTMLElement, options: SlidesEditorOptions): MountedSlides {
  checkOptions(options);
  const root = createRoot(element);
  const render = (next: SlidesEditorOptions) =>
    root.render(
      <StrictMode>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <SlidesEditor key={keyOf(next)} {...next} />
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  render(options);
  return { update: (next) => (checkOptions(next), render(next)), unmount: () => root.unmount() };
}
