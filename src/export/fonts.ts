import bold from "../../fonts/NotoSans-bold.ttf";
import boldItalic from "../../fonts/NotoSans-bold-italic.ttf";
import italic from "../../fonts/NotoSans-italic.ttf";
import regular from "../../fonts/NotoSans-regular.ttf";

/**
 * Noto Sans (SIL OFL 1.1), cut down to Latin, Latin Extended, Greek, Cyrillic, general
 * punctuation, and a few symbols. The files ship inside the bundle, so export loads
 * nothing from the network. See fonts/OFL.txt.
 */
const decode = (data: string | Uint8Array | ArrayBuffer): Uint8Array =>
  typeof data === "string"
    ? Uint8Array.from(atob(data), (char) => char.charCodeAt(0))
    : new Uint8Array(data);

export const NOTO_SANS = {
  regular: decode(regular),
  bold: decode(bold),
  italic: decode(italic),
  boldItalic: decode(boldItalic),
};
