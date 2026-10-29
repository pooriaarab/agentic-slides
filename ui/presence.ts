import { useEffect, useState } from "react";
import type { PresenceEntry } from "agentic-design/react";
import { SyncClient, type Peer } from "agentic-realtime/client";

/** The principal kind of a peer is set by the server from the token, so `machine` is true for an agent. */
export const entryOf = (peer: Peer): PresenceEntry => ({ id: `peer-${peer.clientId}`, name: peer.name, kind: peer.machine ? "agent" : "person" });

/**
 * A browser cannot set a header on a WebSocket. It sends the token as a subprotocol,
 * and the server reads it from there on the room route only.
 */
const bearerSocket = (token: string) =>
  class extends WebSocket {
    constructor(url: string) {
      super(url, [`bearer.${token}`]);
    }
  };

export type Live = "connecting" | "live" | "unavailable";

/** The other people and agents in the live room of a deck. The room holds presence only: edits go through the API. */
export function usePresence(token: string, deck: string, name: string): { peers: PresenceEntry[]; live: Live } {
  const [peers, setPeers] = useState<PresenceEntry[]>([]);
  const [live, setLive] = useState<Live>("connecting");
  useEffect(() => {
    const url = new URL(`/api/v1/slides/decks/${encodeURIComponent(deck)}/ws`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    setLive("connecting");
    const client = SyncClient.open({
      url: url.toString(),
      presence: { name },
      WebSocket: bearerSocket(token) as never,
      reconnect: { initialMs: 1000, maxMs: 15_000 },
      onStatus: (status) => setLive(status === "connected" ? "live" : status === "connecting" ? "connecting" : "unavailable"),
    });
    const off = client.onPeers((all) => setPeers(all.map(entryOf)));
    return () => {
      off();
      void client.disconnect();
    };
  }, [token, deck, name]);
  return { peers, live };
}
