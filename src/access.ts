import { PRINCIPAL_KINDS, SUBJECT_KINDS, type PrincipalContext, type Subject } from "agentic-identity";
import type { Caller } from "./auth.js";
import { fail, type Principal } from "./core/principal.js";

/** The sharing resource type of a deck. */
export const DECK = "deck";

/** The id of a deck is its resource id. A deck id fits the resource id rules of `agentic-identity`. */
export const DECK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The kinds that are not roots of a chain. They hold roles as an agent that has their name. */
const DELEGATED_KINDS = PRINCIPAL_KINDS.filter((kind) => !(SUBJECT_KINDS as readonly string[]).includes(kind));
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
  return principalsOf(subject).map(({ kind, name }) => `${kind}:${name}`);
}

/** The authors (`kind` and `name`) that a subject stands for in a deck: the subject itself and, for an agent, each delegated token that has its name. */
export function principalsOf(subject: Subject): Principal[] {
  if (subject.kind === "human") return [{ kind: "human", name: subject.id }];
  return [
    { kind: "agent", name: subject.id },
    ...DELEGATED_KINDS.filter((kind) => subject.id.startsWith(`${kind}_`)).map((kind) => ({ kind, name: subject.id.slice(kind.length + 1) }) as Principal),
  ];
}

/** Check a subject that comes from a host: a known kind and a safe id. It returns a copy. An `agent` id that starts with a delegated kind covers that delegated token too, as in `principalsOf`. */
export function checkSubject(subject: Subject): Subject {
  const { kind, id } = (subject ?? {}) as Partial<Subject>;
  const known = (SUBJECT_KINDS as readonly unknown[]).includes(kind);
  if (!known || typeof id !== "string" || !SAFE_SUBJECT.test(id)) fail("INVALID_AUTHOR", "subject needs a known kind and a safe id");
  return { kind: kind!, id: id! };
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
