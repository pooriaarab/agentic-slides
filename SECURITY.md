# Security policy

## Report a problem

Report a vulnerability in private. Use GitHub private vulnerability reporting
on this repository: Security tab, then "Report a vulnerability".

Do not open a public issue for a vulnerability. Do not include real personal
data in a report.

## What to expect

- We confirm receipt within 5 working days.
- We tell you our plan within 30 days.
- We credit you in the release notes if you want that.

## Supported versions

The package is in development. Only the latest commit on `main` gets fixes.

## Secure defaults

- The package ships no default credentials.
- Test-only sign-in is off unless an environment variable turns it on.
- Logs hold no email addresses and no slide content.
- The HTTP API refuses every call until you set `SLIDES_TOKENS`. A token has 32 or more characters
  and names the author of its edits. The Worker refuses to start until `SLIDES_UNSAFE_MEMORY_STORE=1`.
- Every valid token reaches every deck. There is no per-deck owner or role yet.
- Dev tools are not shipped. `wrangler` pulls in `sharp` libvips (LGPL) and `@speed-highlight/core`
  (CC0) as dev dependencies only. Scope a software bill of materials to production dependencies.
- A deck never loads a font, image, or script from the network.
