import { scale, themes } from "agentic-design/tokens";

// The deck page and the present page leave the app, so they carry the token values they use.
// This block holds only those values. The page loads no stylesheet from the network.
const COLORS = ["bg", "surface", "surface-sunken", "text", "text-muted", "text-on-accent", "border", "accent", "accent-text", "agent-text", "focus"] as const;
const SPACE = ["2", "3", "4", "6"] as const;
const RADIUS = ["md"] as const;
const FONT_SIZE = ["sm", "md", "xl"] as const;

const colors = (name: "light" | "dark"): string => COLORS.map((c) => `--agd-color-${c}:${themes[name][c]}`).join(";");

/** The `--agd-*` token values for the page chrome, in light and in dark. The page follows the system theme. */
export function tokenCss(): string {
  const fixed = [
    ...SPACE.map((k) => `--agd-space-${k}:${scale.space[k]}`),
    ...RADIUS.map((k) => `--agd-radius-${k}:${scale.radius[k]}`),
    ...FONT_SIZE.map((k) => `--agd-font-size-${k}:${scale["font-size"][k]}`),
    `--agd-font-family-sans:${scale["font-family"].sans}`,
    `--agd-size-control-touch:${scale.size["control-touch"]}`,
  ].join(";");
  return `:root{color-scheme:light dark;${colors("light")};${fixed}}\n@media (prefers-color-scheme:dark){:root{${colors("dark")}}}`;
}
