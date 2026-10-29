// Bundles the web UI into dist/ui. The Worker serves that folder as static assets.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { themeInitScript } from "agentic-design";

const out = "dist/ui";
await mkdir(out, { recursive: true });
const { metafile } = await build({
  entryPoints: { app: "ui/main.tsx" },
  bundle: true,
  format: "esm",
  target: "es2022",
  outdir: out,
  minify: true,
  jsx: "automatic",
  // The fonts are package files. They are copied, so the page makes no remote request.
  loader: { ".woff2": "file" },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  metafile: true,
});
// The init script sets the saved theme before first paint. It is a file, so the page CSP needs no inline script.
await writeFile(`${out}/theme-init.js`, themeInitScript());
for (const file of ["index.html", "_headers"]) await copyFile(`ui/${file}`, `${out}/${file}`);
// The licenses of the fonts and of the code in app.js. Their terms need the notice with every copy, so the package ships them.
const licenses = `${out}/licenses`;
await mkdir(licenses, { recursive: true });
// Every npm package that the bundle holds, from the build's own list of inputs. A package with no license file fails the build.
const bundled = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = [...input.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].pop();
  if (match) bundled.add(match[1]);
}
const sections = [];
for (const name of [...bundled].sort()) {
  const file = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => `node_modules/${name}/${f}`).find((f) => existsSync(f));
  if (!file) throw new Error(`no license file for ${name}, which the UI bundle holds`);
  sections.push(`## ${name}\n\n${await readFile(file, "utf8")}`);
}
sections.push(await readFile("node_modules/agentic-design/dist/THIRD_PARTY_LICENSES.md", "utf8"));
await writeFile(`${licenses}/THIRD_PARTY_LICENSES.md`, sections.join("\n\n"));
for (const font of ["OFL-Inter.txt", "OFL-JetBrainsMono.txt"]) await copyFile(`node_modules/agentic-design/dist/fonts/${font}`, `${licenses}/${font}`);
