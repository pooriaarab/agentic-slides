export { VERSION } from "./version.js";
export { Deck } from "./core/deck.js";
export type { DeckOutline, ElementPatch, OutlineOptions, SlideOutline, SlideRef } from "./core/deck.js";
export {
  COLOR_TOKENS,
  DEFAULT_THEME,
  LAYOUTS,
  LAYOUT_NAMES,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  checkTheme,
} from "./core/layouts.js";
export type { Box, ColorToken, FontFace, LayoutName, Slot, SlotName, Theme } from "./core/layouts.js";
export { parseInline } from "./core/model.js";
export type { Authorship, Element, NewElement, Run, SlideContent } from "./core/model.js";
export { compileOutline } from "./core/outline.js";
export { PRINCIPAL_KINDS, SlidesError, isMachineMade } from "./core/principal.js";
export type { Issue, Principal, PrincipalKind, SlidesErrorCode } from "./core/principal.js";
export { renderDeck, renderSlide, themeCss } from "./render/html.js";
export type { RenderOptions } from "./render/html.js";
export { renderPresent } from "./render/present.js";
