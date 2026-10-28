export const PRINCIPAL_KINDS = ["human", "agent_of_human", "agent_of_agent", "agent", "user_token"] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Who made a change. Every edit needs one, so machine-made work stays labeled. */
export interface Principal {
  kind: PrincipalKind;
  name: string;
}

export type SlidesErrorCode =
  | "INVALID_AUTHOR"
  | "EMPTY_OUTLINE"
  | "EMPTY_SLIDE"
  | "UNKNOWN_LAYOUT"
  | "TEXT_OVERFLOW"
  | "IMAGE_MISSING"
  | "REMOTE_ASSET"
  | "NO_SLOT"
  | "OUTLINE_INVALID"
  | "NO_SLIDE"
  | "NO_ELEMENT"
  | "OUT_OF_RANGE"
  | "OUT_OF_BOUNDS"
  | "BAD_PATCH"
  | "BAD_THEME"
  | "NO_DECK"
  | "DECK_EXISTS"
  | "INVALID_ID"
  | "UNSUPPORTED_IMAGE";

export interface Issue {
  code: SlidesErrorCode;
  /** 1-based slide number in the outline, when the issue belongs to one slide. */
  slide?: number;
  message: string;
}

export class SlidesError extends Error {
  readonly code: SlidesErrorCode;
  constructor(readonly issues: Issue[]) {
    super(issues.map((i) => (i.slide === undefined ? i.message : `slide ${i.slide}: ${i.message}`)).join("; "));
    this.name = "SlidesError";
    this.code = issues[0]!.code;
  }
}

export const fail = (code: SlidesErrorCode, message: string, slide?: number): never => {
  throw new SlidesError([{ code, message, ...(slide === undefined ? {} : { slide }) }]);
};

/** Content by an agent principal, or by a user token (tagged "via agent"), is machine-made. */
export const isMachineMade = (kind: PrincipalKind): boolean => kind !== "human";

const isPrincipal = (value: unknown): value is Principal => {
  const author = value as Principal | null | undefined;
  return (
    typeof author === "object" &&
    author !== null &&
    PRINCIPAL_KINDS.includes(author.kind) &&
    typeof author.name === "string" &&
    author.name.trim() !== ""
  );
};

export function checkAuthor(author: Principal): Principal {
  if (!isPrincipal(author)) fail("INVALID_AUTHOR", `author needs a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  return { kind: author.kind, name: author.name };
}

/** Read an author from stored data. Missing or unknown data reads as an agent, so it is labeled machine-made. */
export const readPrincipal = (value: unknown): Principal =>
  isPrincipal(value) ? { kind: value.kind, name: value.name } : { kind: "agent", name: "unknown" };

/** Read `<kind>:<name>`. The result still needs `checkAuthor`, which every edit runs. */
export function parsePrincipal(value: string): Principal {
  const cut = value.indexOf(":");
  return { kind: value.slice(0, cut < 0 ? undefined : cut) as PrincipalKind, name: cut < 0 ? "" : value.slice(cut + 1) };
}
