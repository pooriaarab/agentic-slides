# Third-party notices

## Inter and JetBrains Mono

- Files: `dist/ui/*.woff2`, the fonts of the web UI. Latin and Latin Extended subsets only.
- Source: Inter (https://github.com/rsms/inter) and JetBrains Mono (https://github.com/JetBrains/JetBrainsMono),
  as packaged by `agentic-design`.
- License: SIL Open Font License 1.1. Copyright 2016 The Inter Project Authors, and copyright 2020 The JetBrains Mono
  Project Authors. The full texts are in `dist/ui/licenses/OFL-Inter.txt` and `dist/ui/licenses/OFL-JetBrainsMono.txt`.

## Code bundled into the web UI

- Files: `dist/ui/app.js`. It bundles React, React DOM, Scheduler, Yjs, y-protocols, lib0, agentic-realtime, and
  agentic-design, and the packages that agentic-design bundles. The list comes from the build (`scripts/build-ui.mjs`).
- License: MIT, except tslib, which is 0BSD. The full texts are in `dist/ui/licenses/THIRD_PARTY_LICENSES.md`.

## Noto Sans

- Files: `fonts/NotoSans-*.ttf`, bundled into `dist` and embedded in PDF export.
- Source: the Noto Sans fonts of the Noto Project (https://github.com/notofonts/latin-greek-cyrillic),
  in the `@expo-google-fonts/noto-sans` npm package.
- Change: each file is cut down to Latin, Latin Extended, Greek, Cyrillic, general punctuation, and a
  few symbols (U+0020-024F, 0300-052F, 1E00-1EFF, 2000-206F, 20A0-20BF, 2116, 2122, 2190-2193, 2212).
- License: SIL Open Font License 1.1. Copyright 2022 The Noto Project Authors. The full text is in
  `fonts/OFL.txt`.
