<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

> `CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` directly.

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# shadcn/ui is backed by @base-ui, not Radix

The `components/ui/*` primitives wrap `@base-ui/react`, which behaves differently from Radix. Gotchas that have bitten us:

- **No missing-title dev warning.** Unlike Radix, base-ui silently omits `aria-labelledby` when a `DialogContent`/`AlertDialogContent` has no `DialogTitle` — there is no console warning. Always render a `DialogTitle` (use `className="sr-only"` if it should be visually hidden).
- **`DialogContent` defaults to `sm:max-w-sm` (384px).** Any modal that needs to be wider must pass an explicit `className` width override. When adjusting a modal width, check **every** `DialogContent` in the file — the create/edit/reveal dialogs are separate and easy to miss one.
- **No `dismissible` prop.** To make a dialog non-dismissable (e.g. a show-once secret), control `open` and ignore close requests in `onOpenChange`, and pass `showCloseButton={false}`. (`disablePointerDismissal` only covers outside-clicks.)
- **`asChild` doesn't exist.** Use the `render` prop instead (e.g. `<Button render={<Link href=… />}>`).
- **`Select.onValueChange` can fire with `null`.** Guard before assigning to required state.
- **`Checkbox` renders an inline `<span>`, not a `<button>`.** Width/height are ignored on inline elements, so a sized primitive needs an explicit display — `components/ui/checkbox.tsx` carries `inline-flex items-center justify-center`; don't remove it. Flex parents mask the bug (flex items are blockified), which is why a checkbox can look fine inside a flex `<Label>` yet collapse to a border sliver in a table cell. Base-ui also ignores synthetic `el.click()` in tests/tooling — drive it with a full pointerdown/pointerup/click sequence.

# Keep the marketing site and API docs current with features

Sophy has a public face: the marketing landing at `app/(marketing)/page.tsx` (served at `/`) and the API reference at `app/(marketing)/docs/page.tsx` (served at `/docs`). When you add or change user-facing functionality, update them **in the same change** when relevant — it's part of "done", not a follow-up.

- **New or changed API surface** — an endpoint, request/response field, header, status code, or error code → update `/docs` to match. Every API claim there must be grounded in the actual code (`app/v1/*`, `lib/http/*`, `lib/auth/*`).
- **New product capability** (e.g. tool calling, knowledgebases, a new model capability) → add or adjust the landing feature list / copy so the site reflects what Sophy actually does.
- **Purely internal change** (no client- or user-visible effect) → no docs change needed; say so explicitly rather than skipping silently.
- Don't document behavior the proxy doesn't have. The site is light-themed and reuses `components/brand.tsx` + the existing `components/ui/*` primitives (base-ui `render` prop, not `asChild`).
