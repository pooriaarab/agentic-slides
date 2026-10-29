// Bundles the web UI into dist/ui. The Worker serves that folder as static assets.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { themeInitScript } from "agentic-design";

const out = "dist/ui";
await mkdir(out, { recursive: true });
await build({
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
});
// The init script sets the saved theme before first paint. It is a file, so the page CSP needs no inline script.
await writeFile(`${out}/theme-init.js`, themeInitScript());
for (const file of ["index.html", "_headers"]) await copyFile(`ui/${file}`, `${out}/${file}`);
// The licenses of the fonts and of the code in app.js. Their terms need the notice with every copy, so the package ships them.
const licenses = `${out}/licenses`;
await mkdir(licenses, { recursive: true });
const bundled = ["react", "react-dom", "scheduler", "yjs", "lib0", "agentic-realtime", "agentic-design"];
const sections = await Promise.all(bundled.map(async (name) => `## ${name}\n\n${await readFile(`node_modules/${name}/LICENSE`, "utf8")}`));
sections.push(await readFile("node_modules/agentic-design/dist/THIRD_PARTY_LICENSES.md", "utf8"));
await writeFile(`${licenses}/THIRD_PARTY_LICENSES.md`, sections.join("\n\n"));
for (const font of ["OFL-Inter.txt", "OFL-JetBrainsMono.txt"]) await copyFile(`node_modules/agentic-design/dist/fonts/${font}`, `${licenses}/${font}`);
