import { describe, expect, test } from "vitest";
import { keyOfRoomPrincipal, roomPrincipalFits, roomPrincipalId, roomPrincipals } from "./access.js";

describe("room principal ids", () => {
  test("the ids of a subject are unique across kinds", () => {
    const ids = [
      ...roomPrincipals({ kind: "human", id: "ada" }),
      ...roomPrincipals({ kind: "agent", id: "bot" }),
      ...roomPrincipals({ kind: "agent", id: "agent_of_human_eve" }),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(["human.ada", "agent.bot", "agent.agent_of_human_eve", "agent_of_human.eve"]));
  });

  test("a subject keeps only the ids that the room takes at the length limit", () => {
    // `agent.agent_of_human_` plus 113 characters is 134 characters, which the room refuses. Its delegated id still fits.
    const name = "a".repeat(113);
    expect(roomPrincipals({ kind: "agent", id: `agent_of_human_${name}` })).toEqual([`agent_of_human.${name}`]);
    expect(roomPrincipals({ kind: "human", id: "a".repeat(128) })).toEqual([]);
  });

  test("a token name that makes a room id longer than 128 characters does not fit", () => {
    expect(roomPrincipalFits("human", "a".repeat(122))).toBe(true);
    expect(roomPrincipalFits("human", "a".repeat(123))).toBe(false);
    expect(roomPrincipalFits("agent_of_human", "a".repeat(113))).toBe(true);
    expect(roomPrincipalFits("agent_of_human", "a".repeat(114))).toBe(false);
    expect(roomPrincipalFits("agent_of_agent", "a".repeat(113))).toBe(true);
    expect(roomPrincipalFits("agent_of_agent", "a".repeat(114))).toBe(false);
    expect(roomPrincipalFits("user_token", "a".repeat(117))).toBe(true);
    expect(roomPrincipalFits("user_token", "a".repeat(118))).toBe(false);
  });

  test("a room id maps back to its key, and an old key keeps its colon", () => {
    expect(keyOfRoomPrincipal("agent_of_human.eve")).toBe("agent_of_human:eve");
    expect(keyOfRoomPrincipal("human:ada.lovelace")).toBe("human:ada.lovelace");
  });
});
