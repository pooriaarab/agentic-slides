import type { PrincipalContext, Subject } from "agentic-identity";
import type { Caller } from "./auth.js";

/** The sharing resource type of a deck. */
export const DECK = "deck";

/** The id of a deck is its resource id. A deck id fits the resource id rules of `agentic-identity`. */
export const DECK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const DELEGATED_KINDS = ["agent_of_human", "agent_of_agent", "user_token"] as const;
const DELEGATED_PREFIX = new RegExp(`^(${DELEGATED_KINDS.join("|")})_`);
const SAFE_SUBJECT = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The subject that a token holds roles as. Only a person (`human`) and an agent with its own identity (`agent`) are roots in
 * `agentic-identity`. Any other kind is a token of a delegated agent: it holds roles as an agent named `<kind>_<name>`, so it never
 * shares the roles of a person or of another kind with the same name. It returns null when the id is not safe, so no role applies.
 */
export function subjectOf(caller: Caller): Subject | null {
  const { kind, name } = caller.author;
  if (kind === "human") return SAFE_SUBJECT.test(name) ? { kind, id: name } : null;
  // An `agent` named like `agent_of_human_eve` would share the subject of the delegated token `agent_of_human:eve`. It holds no role.
  if (kind === "agent" && DELEGATED_PREFIX.test(name)) return null;
  const id = kind === "agent" ? name : `${kind}_${name}`;
  return SAFE_SUBJECT.test(id) ? { kind: "agent", id } : null;
}

/**
 * The room principal ids (`<kind>:<name>`) of the tokens that hold a subject. A room keeps the role that it got at connect time,
 * so a change of role reaches every socket of these ids.
 */
export function roomPrincipals(subject: Subject): string[] {
  if (subject.kind === "human") return [`human:${subject.id}`];
  return [
    `agent:${subject.id}`,
    ...DELEGATED_KINDS.filter((kind) => subject.id.startsWith(`${kind}_`)).map((kind) => `${kind}:${subject.id.slice(kind.length + 1)}`),
  ];
}

/**
 * The caller as an `agentic-identity` principal. A viewer token can only read, so its scope stops there, even for an owner.
 * An editor token leaves the decision to the role of the person or agent on the deck.
 */
export function contextOf(caller: Caller): PrincipalContext | null {
  const subject = subjectOf(caller);
  if (!subject) return null;
  return {
    principalId: subject.id,
    kind: subject.kind,
    chain: [{ id: subject.id, kind: subject.kind }],
    scopes: [caller.role === "viewer" ? `${DECK}:read` : `${DECK}:admin`],
  };
}
