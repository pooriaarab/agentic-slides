#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { COMMAND, DESCRIPTION } from "./brand.js";
import { VERSION } from "./version.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const helpText = (): string =>
  [`${COMMAND} ${VERSION}`, DESCRIPTION, "", `Usage: ${COMMAND} [--help] [--version]`].join("\n");

export function runCli(argv: string[], io: CliIo): number {
  const [first] = argv;
  if (first === undefined || first === "--help" || first === "-h") {
    io.out(helpText());
    return 0;
  }
  if (first === "--version" || first === "-V") {
    io.out(VERSION);
    return 0;
  }
  io.err(`unknown command "${first}". Run "${COMMAND} --help" for usage.`);
  return 2;
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const code = runCli(process.argv.slice(2), { out: (l) => console.log(l), err: (l) => console.error(l) });
  if (code !== 0) process.exit(code);
}
