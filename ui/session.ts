import { createClient, type Me, type SlidesClient } from "../src/client.js";

const KEY = "slides-token";

/** The token lives in this tab only. It never goes to local storage, so closing the tab signs out. */
export const savedToken = (): string | null => sessionStorage.getItem(KEY);
export const saveToken = (token: string) => sessionStorage.setItem(KEY, token);
export const clearToken = () => sessionStorage.removeItem(KEY);

export const clientFor = (token: string): SlidesClient => createClient({ baseUrl: location.origin, token });
export type { Me, SlidesClient };

/** A short message for an error, with no stack and no token. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "Something went wrong.");
