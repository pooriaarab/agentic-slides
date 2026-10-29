import { useEffect, useState } from "react";

export type Route = { name: "decks" } | { name: "deck"; id: string } | { name: "present"; id: string; at: number };

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Reads `#/deck/<id>` and `#/deck/<id>/present/<n>`. Anything else is the deck list. */
export function parseRoute(hash: string): Route {
  const [, area, id, view, at] = hash.split("/");
  if (area === "deck" && id && ID.test(id)) {
    if (view === "present") return { name: "present", id, at: Math.max(1, Number.parseInt(at ?? "1", 10) || 1) };
    return { name: "deck", id };
  }
  return { name: "decks" };
}

export const hrefOf = (route: Route): string =>
  route.name === "decks" ? "#/" : route.name === "deck" ? `#/deck/${route.id}` : `#/deck/${route.id}/present/${route.at}`;

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return parseRoute(hash);
}
