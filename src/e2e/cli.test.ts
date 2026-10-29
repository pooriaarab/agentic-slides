import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

function runAsync(args: string[], input: string): Promise<{ code: number | null; err: string }> {
  return new Promise((done) => {
    const child = spawn("node", [CLI, ...args], { cwd: work, env: { PATH: process.env.PATH } });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => done({ code, err }));
    child.stdin.end(input);
  });
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

  test("lists decks as JSON, newest edit first, and pages with a cursor", () => {
    const dir = ["--dir", join(work, ".list")];
    expect(json(run(["list", ...dir]).out)).toEqual({ decks: [] });
    run(["new", "First", "--id", "one", "--as", AGENT, ...dir]);
    run(["new", "Second", "--id", "two", "--as", "human:ada", ...dir]);
    const all = json(run(["list", ...dir]).out);
    expect(all.decks.map((d: any) => d.id).sort()).toEqual(["one", "two"]);
    expect(all.decks.find((d: any) => d.id === "one")).toMatchObject({ title: "First", machineMade: true, editedBy: { kind: "agent_of_human", name: "writer-bot" } });
    const first = json(run(["list", "--limit", "1", ...dir]).out);
    expect(first.decks).toHaveLength(1);
    const next = json(run(["list", "--limit", "1", "--cursor", first.nextCursor, ...dir]).out);
    expect(next.decks).toHaveLength(1);
    expect(next.decks[0].id).not.toBe(first.decks[0].id);
    expect(run(["list", "--limit", "many", ...dir]).code).toBe(2);
    expect(json(run(["list", "--limit", "0", ...dir]).err).error.code).toBe("BAD_PATCH");
    expect(json(run(["list", "--cursor", "bad", ...dir]).err).error.code).toBe("BAD_PATCH");
  });

  test("delete-deck removes the deck and its list entry", () => {
    const dir = ["--dir", join(work, ".del")];
    run(["new", "Doomed", "--id", "doomed", "--as", AGENT, ...dir]);
    run(["new", "Kept", "--id", "kept", "--as", AGENT, ...dir]);
    expect(run(["delete-deck", "doomed", ...dir]).code).toBe(2);
    expect(json(run(["delete-deck", ...dir, "--as", AGENT]).err).error.code).toBe("INVALID_ID");
    expect(json(run(["delete-deck", "../x", "--as", AGENT, ...dir]).err).error.code).toBe("INVALID_ID");
    expect(json(run(["delete-deck", "doomed", "--as", AGENT, ...dir]).out)).toEqual({ ok: true });
    expect(json(run(["outline", "doomed", ...dir]).err).error.code).toBe("NO_DECK");
    expect(json(run(["delete-deck", "doomed", "--as", AGENT, ...dir]).err).error.code).toBe("NO_DECK");
    expect(json(run(["list", ...dir]).out).decks.map((d: any) => d.id)).toEqual(["kept"]);
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
    const before = readFileSync(join(work, ".slides", "store.json"), "utf8");
    const result = run(["add", "bad", "--outline", "-", "--as", AGENT], {
      input: "layout: zigzag\n# A\n---\n# B\n![x](missing.png)\n---\n# C\n![x](https://cdn.example.com/c.png)",
    });
    expect(result.code).toBe(1);
    const { error } = json(result.err);
    expect(error.issues.map((i: any) => [i.code, i.slide])).toEqual([["UNKNOWN_LAYOUT", 1], ["IMAGE_MISSING", 2], ["REMOTE_ASSET", 3]]);
    expect(readFileSync(join(work, ".slides", "store.json"), "utf8")).toBe(before);
    expect(run(["add", "bad", "--outline", "-", "--as", AGENT], { input: "" }).err).toContain("EMPTY_OUTLINE");
  });

  test("a file that is not an image is refused and nothing is stored", () => {
    const env = { SLIDES_DIR: join(work, "fake-store") };
    run(["new", "Img", "--id", "img", "--as", AGENT], { env });
    mkdirSync(join(work, "pics"), { recursive: true });
    writeFileSync(join(work, "pics", "fake.png"), "<svg onload=alert(1)>");
    const result = run(["add", "img", "--outline", "-", "--as", AGENT], { input: "# P\n![x](pics/fake.png)", env });
    expect(json(result.err).error.code).toBe("UNSUPPORTED_IMAGE");
    expect(existsSync(join(work, "fake-store", "blobs")) ? readdirSync(join(work, "fake-store", "blobs")) : []).toEqual([]);
  });

  test("characters the PDF font cannot draw are reported, not hidden", () => {
    run(["new", "Han", "--id", "han", "--as", AGENT]);
    run(["add", "han", "--outline", "-", "--as", AGENT], { input: "# 日本語\n- 漢字" });
    const exported = json(run(["export", "han", "--out", join(work, "han.pdf")]).out);
    expect(exported.warnings).toHaveLength(1);
    expect(exported.warnings[0]).toContain("slide 1");
    expect(exported.warnings[0]).toContain("日");
  });

  test("Polish, Greek, and Cyrillic text is embedded with no warning", () => {
    const text = "Łódź zażółć gęślą jaźń\nΕλληνικά κείμενο\nПривет, мир";
    run(["new", "Scripts", "--id", "scripts", "--as", AGENT]);
    run(["add", "scripts", "--outline", "-", "--as", AGENT], { input: `# ${text.split("\n")[0]}\n${text.split("\n").slice(1).map((l) => `- ${l}`).join("\n")}` });
    const pdf = join(work, "scripts.pdf");
    const exported = json(run(["export", "scripts", "--out", pdf]).out);
    expect(exported.warnings).toEqual([]);
    expect(readFileSync(pdf).length).toBeLessThan(120_000);
    const again = join(work, "scripts2.pdf");
    run(["export", "scripts", "--out", again]);
    expect(readFileSync(again).equals(readFileSync(pdf))).toBe(true);
  });

  test("SLIDES_DIR and SLIDES_AUTHOR set the defaults", () => {
    const env = { SLIDES_DIR: join(work, "other"), SLIDES_AUTHOR: "human:ada" };
    expect(run(["new", "Env", "--id", "env"], { env }).code).toBe(0);
    const outline = json(run(["outline", "env"], { env }).out);
    expect(outline).toMatchObject({ editedBy: { kind: "human" }, machineMade: false });
  });

  test("a bad outline with a valid image leaves no blob behind", () => {
    const env = { SLIDES_DIR: join(work, "orphan-store") };
    run(["new", "Orphan", "--id", "orphan", "--as", AGENT], { env });
    const result = run(["add", "orphan", "--outline", "-", "--as", AGENT], { input: "layout: zigzag\n# A\n![x](cat.png)", env });
    expect(json(result.err).error.code).toBe("UNKNOWN_LAYOUT");
    expect(existsSync(join(work, "orphan-store", "blobs")) ? readdirSync(join(work, "orphan-store", "blobs")) : []).toEqual([]);
  });

  test("eight processes adding at once lose no slide", async () => {
    run(["new", "Race", "--id", "race", "--as", AGENT]);
    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => runAsync(["add", "race", "--outline", "-", "--as", AGENT], `# S${i}`)));
    expect(runs.map((r) => r.code)).toEqual(Array(8).fill(0));
    const titles = json(run(["outline", "race"]).out).slides.map((s: any) => s.title).sort();
    expect(titles).toEqual(Array.from({ length: 8 }, (_, i) => `S${i}`).sort());
  });

  test("a bad image src is a coded error and the deck stays whole", () => {
    run(["new", "Src", "--id", "src", "--as", AGENT]);
    run(["add", "src", "--outline", "outline.md", "--as", AGENT]);
    const outline = json(run(["outline", "src"]).out);
    const image = outline.slides[1].elements.find((e: any) => e.kind === "image");
    const patch = (src: string) => run(["edit", "src", "--slide", "2", "--element", image.id, "--patch", JSON.stringify({ src }), "--as", AGENT]);
    expect(json(patch("blob:sha256-dead").err).error.code).toBe("REMOTE_ASSET");
    expect(json(patch("blob:../x").err).error.code).toBe("REMOTE_ASSET");
    expect(json(patch(`blob:sha256-${"0".repeat(64)}`).err).error.code).toBe("IMAGE_MISSING");
    expect(json(run(["add", "src", "--outline", "-", "--as", AGENT], { input: "layout: image-right\n# a\n![x](blob:a/b)" }).err).error.code).toBe("IMAGE_MISSING");
    expect(run(["render", "src", "--out", join(work, "src.html")]).code).toBe(0);
    expect(json(run(["export", "src", "--out", join(work, "src.pdf")]).out).warnings).toEqual([]);
  });

  test("a patch that is not an object is a coded error", () => {
    run(["new", "Patch", "--id", "patch", "--as", AGENT]);
    run(["add", "patch", "--outline", "-", "--as", AGENT], { input: "# T" });
    const id = json(run(["outline", "patch"]).out).slides[0].elements.find((e: any) => e.slot === "title").id;
    for (const bad of ["null", "[]", '{"alt":5}']) {
      expect(json(run(["edit", "patch", "--slide", "1", "--element", id, "--patch", bad, "--as", AGENT]).err).error.code).toBe("BAD_PATCH");
    }
  });

  test("an outline can read images only from its own folder", () => {
    run(["new", "Sandbox", "--id", "sandbox", "--as", AGENT]);
    mkdirSync(join(work, "docs"), { recursive: true });
    writeFileSync(join(work, "docs", "in.md"), "layout: image-right\n# a\n![x](../cat.png)");
    const outside = run(["add", "sandbox", "--outline", "docs/in.md", "--as", AGENT]);
    expect(json(outside.err).error.code).toBe("IMAGE_MISSING");
    writeFileSync(join(work, "docs", "abs.md"), `layout: image-right\n# a\n![x](${join(work, "cat.png")})`);
    expect(json(run(["add", "sandbox", "--outline", "docs/abs.md", "--as", AGENT]).err).error.code).toBe("IMAGE_MISSING");
    symlinkSync("/dev/zero", join(work, "docs", "zero.png"));
    writeFileSync(join(work, "docs", "zero.md"), "layout: image-right\n# a\n![x](zero.png)");
    expect(json(run(["add", "sandbox", "--outline", "docs/zero.md", "--as", AGENT]).err).error.code).toBe("IMAGE_MISSING");
    writeFileSync(join(work, "docs", "big.png"), Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));
    writeFileSync(join(work, "docs", "big.md"), "layout: image-right\n# a\n![x](big.png)");
    expect(json(run(["add", "sandbox", "--outline", "docs/big.md", "--as", AGENT]).err).error.code).toBe("UNSUPPORTED_IMAGE");
    writeFileSync(join(work, "docs", "ok.md"), "layout: image-right\n# a\n![x](../cat.png)");
  });

  test("a title that wraps past its box is reported, not silently cut", () => {
    run(["new", "Wide", "--id", "wide", "--as", AGENT]);
    run(["add", "wide", "--outline", "-", "--as", AGENT], { input: `# ${Array(4).fill("W".repeat(10)).join(" ")}` });
    const exported = json(run(["export", "wide", "--out", join(work, "wide.pdf")]).out);
    expect(exported.warnings.join(" ")).toMatch(/slide 1.*cut/);
  });
});

describe("mcp flags", () => {
  test("mcp --help and mcp --version answer and exit 0 without a server", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    for (const flag of ["--help", "-h"]) {
      const help = run(["mcp", flag, "--dir", "x"], { input: "" });
      expect([help.code, help.out]).toEqual([0, expect.stringContaining("Usage")]);
    }
    for (const flag of ["--version", "-V"]) {
      const version = run(["mcp", flag, "--dir", "x"], { input: "" });
      expect([version.code, version.out.trim()]).toEqual([0, pkg.version]);
    }
  });
});
