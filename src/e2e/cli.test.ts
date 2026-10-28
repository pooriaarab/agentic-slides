import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "@cantoo/pdf-lib";
import { beforeAll, describe, expect, test } from "vitest";

// End to end: the built CLI, a real store on disk, real files. Needs `npm run build`.
const CLI = join(process.cwd(), "dist", "cli.js");
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const work = mkdtempSync(join(tmpdir(), "slides-cli-"));
const AGENT = "agent_of_human:writer-bot";

function run(args: string[], options: { input?: string; env?: Record<string, string> } = {}) {
  const result = spawnSync("node", [CLI, ...args], {
    cwd: work,
    encoding: "utf8",
    input: options.input,
    env: { PATH: process.env.PATH, ...options.env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const json = (text: string) => JSON.parse(text) as Record<string, any>;

beforeAll(() => {
  writeFileSync(join(work, "outline.md"), "# Launch\n- **Ship** it\n> hello\n---\n# Pic\n![A cat](cat.png)\n---\n# Facts\n|a|b|\n|1|2|\n");
  writeFileSync(join(work, "cat.png"), PNG);
  writeFileSync(join(work, "notes.txt"), "not an image");
});

describe("slides CLI", () => {
  test("refuses to edit without an author, and rejects an unknown kind", () => {
    expect(run(["new", "Talk"]).code).toBe(2);
    expect(run(["new", "Talk", "--as", "robot:x"]).err).toContain("INVALID_AUTHOR");
    expect(run(["new", "Talk", "--as", "agent"]).code).toBe(1);
  });

  test("usage mistakes exit 2", () => {
    expect(run(["frobnicate"]).code).toBe(2);
    expect(run(["outline", "x", "--nope"]).code).toBe(2);
    expect(run(["move", "x", "--slide", "1", "--to", "two", "--as", AGENT]).code).toBe(2);
    expect(run(["export", "x", "--out", "a.odp", "--format", "odp"]).code).toBe(2);
  });

  test("a deck id cannot reach outside the store", () => {
    for (const id of ["../x", "a/b", ".hidden"]) expect(json(run(["outline", id]).err).error.code).toBe("INVALID_ID");
    expect(json(run(["outline", "nope"]).err).error.code).toBe("NO_DECK");
  });

  test("builds, edits, renders, and exports a deck", () => {
    const created = run(["new", "Launch plan", "--id", "plan", "--as", AGENT]);
    expect(json(created.out)).toEqual({ id: "plan" });
    expect(json(run(["new", "Again", "--id", "plan", "--as", AGENT]).err).error.code).toBe("DECK_EXISTS");

    const added = run(["add", "plan", "--outline", "outline.md", "--as", AGENT]);
    expect(added.code).toBe(0);
    const { slideIds } = json(added.out);
    expect(slideIds).toHaveLength(3);

    let outline = json(run(["outline", "plan"]).out);
    expect(outline.slides.map((s: any) => s.title)).toEqual(["Launch", "Pic", "Facts"]);
    expect(outline.slides[0]).toMatchObject({ createdBy: { kind: "agent_of_human", name: "writer-bot" }, machineMade: true });
    const image = outline.slides[1].elements.find((e: any) => e.kind === "image");
    expect(image).toMatchObject({ alt: "A cat" });
    expect(image.src).toMatch(/^blob:sha256-[0-9a-f]{64}$/);

    const title = outline.slides[0].elements.find((e: any) => e.slot === "title");
    expect(run(["edit", "plan", "--slide", "1", "--element", title.id, "--patch", '{"text":"Launch **now**","x":100}', "--as", "human:ada"]).code).toBe(0);
    expect(run(["edit", "plan", "--slide", slideIds[2], "--outline", "-", "--as", AGENT], { input: "# Facts v2\n- one" }).code).toBe(0);
    expect(run(["move", "plan", "--slide", "3", "--to", "1", "--as", AGENT]).code).toBe(0);
    expect(run(["add", "plan", "--layout", "section", "--at", "2", "--as", AGENT]).code).toBe(0);

    outline = json(run(["outline", "plan"]).out);
    expect(outline.slides.map((s: any) => s.layout)).toEqual(["title-body", "section", "title-body", "image-right"]);
    expect(outline.slides[0].title).toBe("Facts v2");
    const edited = outline.slides[2].elements.find((e: any) => e.slot === "title");
    expect(edited).toMatchObject({ x: 100, createdBy: { kind: "agent_of_human" }, editedBy: { kind: "human", name: "ada" } });
    expect(outline.editedBy.kind).toBe("agent_of_human");
    expect(run(["delete", "plan", "--slide", "2", "--as", AGENT]).code).toBe(0);
    expect(json(run(["outline", "plan"]).out).slides).toHaveLength(3);

    const html = run(["render", "plan", "--present"]).out;
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Facts v2");
    expect(html).not.toMatch(/https?:/);
    const page = join(work, "deck.html");
    expect(run(["render", "plan", "--out", page]).code).toBe(0);
    expect(readFileSync(page, "utf8")).toContain("data:image/png;base64,");

    const pdf = join(work, "deck.pdf");
    const exported = json(run(["export", "plan", "--out", pdf]).out);
    expect(exported).toMatchObject({ path: pdf, warnings: [] });
    const doc = PDFDocument.load(readFileSync(pdf));
    return doc.then((loaded) => {
      expect(loaded.getPageCount()).toBe(3);
      expect(loaded.getPage(0).getSize()).toEqual({ width: 1280, height: 720 });
      expect(readFileSync(pdf).subarray(0, 5).toString()).toBe("%PDF-");
      const again = join(work, "deck2.pdf");
      run(["export", "plan", "--out", again]);
      expect(readFileSync(again).equals(readFileSync(pdf))).toBe(true);
    });
  });

  test("a bad outline exits 1 with every issue, and the store does not change", () => {
    run(["new", "Bad", "--id", "bad", "--as", AGENT]);
    const before = readFileSync(join(work, ".slides", "store", "decks", "bad.json"), "utf8");
    const result = run(["add", "bad", "--outline", "-", "--as", AGENT], {
      input: "layout: zigzag\n# A\n---\n# B\n![x](missing.png)\n---\n# C\n![x](https://cdn.example.com/c.png)",
    });
    expect(result.code).toBe(1);
    const { error } = json(result.err);
    expect(error.issues.map((i: any) => [i.code, i.slide])).toEqual([["UNKNOWN_LAYOUT", 1], ["IMAGE_MISSING", 2], ["REMOTE_ASSET", 3]]);
    expect(readFileSync(join(work, ".slides", "store", "decks", "bad.json"), "utf8")).toBe(before);
    expect(run(["add", "bad", "--outline", "-", "--as", AGENT], { input: "" }).err).toContain("EMPTY_OUTLINE");
  });

  test("a file that is not an image is refused and nothing is stored", () => {
    run(["new", "Img", "--id", "img", "--as", AGENT]);
    mkdirSync(join(work, "pics"), { recursive: true });
    writeFileSync(join(work, "pics", "fake.png"), "<svg onload=alert(1)>");
    const result = run(["add", "img", "--outline", "-", "--as", AGENT], { input: "# P\n![x](pics/fake.png)" });
    expect(json(result.err).error.code).toBe("UNSUPPORTED_IMAGE");
  });

  test("characters the PDF font cannot draw are reported, not hidden", () => {
    run(["new", "Polish", "--id", "polish", "--as", AGENT]);
    run(["add", "polish", "--outline", "-", "--as", AGENT], { input: "# Łódź\n- zażółć" });
    const exported = json(run(["export", "polish", "--out", join(work, "polish.pdf")]).out);
    expect(exported.warnings).toHaveLength(1);
    expect(exported.warnings[0]).toContain("slide 1");
    expect(exported.warnings[0]).toContain("Ł");
  });

  test("SLIDES_DIR and SLIDES_AUTHOR set the defaults", () => {
    const env = { SLIDES_DIR: join(work, "other"), SLIDES_AUTHOR: "human:ada" };
    expect(run(["new", "Env", "--id", "env"], { env }).code).toBe(0);
    const outline = json(run(["outline", "env"], { env }).out);
    expect(outline).toMatchObject({ editedBy: { kind: "human" }, machineMade: false });
  });
});
