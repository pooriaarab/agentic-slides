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
  | "BAD_THEME";

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

export function checkAuthor(author: Principal): Principal {
  const ok =
    typeof author === "object" &&
    author !== null &&
    PRINCIPAL_KINDS.includes(author.kind) &&
    typeof author.name === "string" &&
    author.name.trim() !== "";
  if (!ok) fail("INVALID_AUTHOR", `author needs a kind (${PRINCIPAL_KINDS.join(", ")}) and a name`);
  return { kind: author.kind, name: author.name };
}
