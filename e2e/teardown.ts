import { rmSync } from "node:fs";

/** Removes the state of the two Workers. */
export default function teardown() {
  if (process.env.E2E_STATE) rmSync(process.env.E2E_STATE, { recursive: true, force: true });
}
