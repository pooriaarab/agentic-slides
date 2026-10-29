// The editor for an app that embeds it: `agentic-slides/ui`. The app gives a deck id, a client, and the principal who uses
// the editor. The web UI that the Worker serves renders the same component. React and react-dom are peer dependencies.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "agentic-design/react";
import "./app.css";
import { PRINCIPAL_KINDS, type PrincipalKind } from "../src/core/principal.js";
import type { SlidesClient } from "../src/client.js";
import { Editor } from "./editor.js";

export type { SlidesClient };

/** Who uses the editor. The server still checks every write against its own token. */
export interface EmbedPrincipal {
  kind: PrincipalKind;
  name: string;
  /** Only `editor` can change the deck. Any other value, or no value, opens it read only. */
  role?: "editor" | "viewer";
}

export interface SlidesEditorOptions {
  /** A client from `createClient` in `agentic-slides/client`. */
  client: SlidesClient;
  /** The deck id. */
  docId: string;
  principal: EmbedPrincipal;
  /** Force read only, even for an editor. */
  readOnly?: boolean;
  /** The live room for presence. Give the bearer token, and the origin when it is not the page origin. Without it, the editor shows no presence. */
  presence?: { token: string; origin?: string };
  /** Called with the 1-based slide number when the person picks Present. The default sets the page address. */
  onPresent?: (slide: number) => void;
}

/** A principal must have a known kind and a name. A missing kind is an error, never a default. */
function checkPrincipal(principal: EmbedPrincipal): void {
  if (!principal || !PRINCIPAL_KINDS.includes(principal.kind) || typeof principal.name !== "string" || principal.name.trim() === "") {
    throw new TypeError(`the editor needs a principal with a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  }
}

/** The editor for one deck. It needs the theme, tooltip, and toast providers above it. `mount` adds them. */
export function SlidesEditor({ client, docId, principal, readOnly, presence, onPresent }: SlidesEditorOptions) {
  checkPrincipal(principal);
  return <Editor client={client} id={docId} name={principal.name} canWrite={principal.role === "editor" && !readOnly} token={presence?.token} origin={presence?.origin} onPresent={onPresent} />;
}

export interface MountedSlides {
  /** Show another deck or principal in the same place. A bad principal throws and keeps the editor as it is. */
  update(options: SlidesEditorOptions): void;
  /** Remove the editor and stop its timers and live connection. */
  unmount(): void;
}

/** Render the editor into an element, for an app that does not use React itself. */
export function mount(element: HTMLElement, options: SlidesEditorOptions): MountedSlides {
  checkPrincipal(options.principal);
  const root = createRoot(element);
  const render = (next: SlidesEditorOptions) =>
    root.render(
      <StrictMode>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <SlidesEditor key={next.docId} {...next} />
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </StrictMode>,
    );
  render(options);
  return { update: (next) => (checkPrincipal(next.principal), render(next)), unmount: () => root.unmount() };
}
