import type { SVGProps } from "react";

const base = (p: SVGProps<SVGSVGElement>) => ({ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false, ...p }) as SVGProps<SVGSVGElement>;

export const UpIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>;
export const DownIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" /></svg>;
export const TrashIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.5h6.6l.7-8.5" /></svg>;
export const PlayIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M5 3l8 5-8 5z" /></svg>;
export const ImageIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="m2.5 11.5 3.5-3.5 3 3 2-2 2.5 2.5" /></svg>;
export const RefreshIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base(p)}><path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5" /></svg>;
