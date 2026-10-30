export * from "./mount.js";

/** Render a host outline as PDF bytes. Load the renderer only when called. */
export async function renderPdf(...args: Parameters<typeof import("../src/export/pdf.js").renderPdf>) {
  return (await import("../src/export/pdf.js")).renderPdf(...args);
}
