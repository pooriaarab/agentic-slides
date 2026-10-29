import bold from "../../fonts/NotoSans-bold.ttf";
import boldItalic from "../../fonts/NotoSans-bold-italic.ttf";
import italic from "../../fonts/NotoSans-italic.ttf";
import regular from "../../fonts/NotoSans-regular.ttf";

/**
 * Noto Sans (SIL OFL 1.1), cut down to Latin, Latin Extended, Greek, Cyrillic, general
 * punctuation, and a few symbols. The files ship inside the bundle, so export loads
 * nothing from the network. See fonts/OFL.txt.
 */
export const NOTO_SANS = {
  regular: new Uint8Array(regular),
  bold: new Uint8Array(bold),
  italic: new Uint8Array(italic),
  boldItalic: new Uint8Array(boldItalic),
};
