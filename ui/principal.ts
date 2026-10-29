import type { PresenceEntry } from "agentic-design/react";
import type { Principal } from "../src/client.js";

/** Only a human is a person. An agent, or a user token that acts as a person, shows as an agent. */
export const entryOfPrincipal = (who: Principal | undefined): PresenceEntry =>
  who ? { id: `${who.kind}:${who.name}`, name: who.name, kind: who.kind === "human" ? "person" : "agent" } : { id: "unknown", name: "Unknown", kind: "person" };
