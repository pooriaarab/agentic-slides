import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

// End to end: export a deck with the built CLI, then read the PDF back with poppler's
// `pdftotext`. The text that comes out shows the ToUnicode map is right. Needs `npm run build`
// and poppler-utils.
const CLI = join(process.cwd(), "dist", "cli.js");
const work = mkdtempSync(join(tmpdir(), "slides-text-"));
const AGENT = "agent_of_human:writer-bot";

const run = (args: string[], input?: string) => {
  const result = spawnSync("node", [CLI, ...args], { cwd: work, encoding: "utf8", input, env: { PATH: process.env.PATH } });
  return { code: result.status, out: result.stdout, err: result.stderr };
};

function exportText(id: string, outline: string): { text: string; warnings: string[] } {
  expect(run(["new", id, "--id", id, "--as", AGENT]).code).toBe(0);
  expect(run(["add", id, "--outline", "-", "--as", AGENT], outline).code).toBe(0);
  const pdf = join(work, `${id}.pdf`);
  const exported = run(["export", id, "--out", pdf]);
  expect(exported.code).toBe(0);
  const text = spawnSync("pdftotext", [pdf, "-"], { encoding: "utf8" });
  expect(text.error, "pdftotext must be installed").toBeUndefined();
  expect(text.status).toBe(0);
  return { text: text.stdout, warnings: JSON.parse(exported.out).warnings };
}

beforeAll(() => writeFileSync(join(work, ".keep"), ""));

describe("PDF text round trip", () => {
  test("Latin, Greek, and Cyrillic text comes back exactly", () => {
    const lines = ["Łódź zażółć gęślą jaźń", "Ελληνικά κείμενο: άέήίόύώ", "Привет, мир: ЁЖЩЮЯ ёжщюя", "café naïve façade"];
    const { text, warnings } = exportText("scripts", `# Title ${lines[3]}\n${lines.slice(0, 3).map((l) => `- ${l}`).join("\n")}\n---\n# Table\n|Λ|Ж|\n|ω|ж|`);
    expect(warnings).toEqual([]);
    const got = text.split("\n").map((l) => l.trim().replace(/^• /, ""));
    for (const line of lines.slice(0, 3)) expect(got, line).toContain(line);
    expect(got).toContain(`Title ${lines[3]}`);
    for (const cell of ["Λ", "Ж", "ω", "ж"]) expect(got, cell).toContain(cell);
  });

  test("bold and italic runs come back as the same text", () => {
    const { text } = exportText("styled", "# Styled\nПривет **жирный** and *курсив* ΩΩ");
    expect(text).toContain("Привет жирный and курсив ΩΩ");
  });

  test("unsupported scripts become question marks with a warning", () => {
    const { text, warnings } = exportText("han", "# Ok 日本語\n- 漢字");
    expect(text).toContain("Ok ???");
    expect(text).toContain("??");
    expect(text).not.toMatch(/[日本語漢字]/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('with "?"');
    for (const ch of ["日", "本", "語", "漢", "字"]) expect(warnings[0]).toContain(ch);
  });
});
