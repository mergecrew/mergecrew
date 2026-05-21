# 05 · Bureau / Coral design system

The web app (`apps/web`) ships the Bureau visual direction with the Coral palette as of v0.4 (May 2026, EPIC #653). This doc is the contributor pointer; the canonical source lives in `~/Downloads/design_handoff_mergecrew_redesign/` for now and will be moved into-tree once the handoff bundle is published as an OSS reference.

## Conventions to follow

- **Use design-system primitives**, not raw HTML + Tailwind colours. Everything you need is exported from `apps/web/src/components/ui.tsx`:
  - Surfaces — `Card`, `CardHead`, `CardBody`
  - Buttons — `Button`, `LinkButton` (variants: `primary` ink-on-paper · `accent` marine blue · `energy` coral · `ghost` outlined · `danger` outlined coral)
  - Status — `StatusDot`, `StatBadge`, `Chip`, `RolePill`
  - Form — `FieldRow`, `ToggleRow`, `Toggle`, `Input`
  - Layout — `PageHead`, `Tile`, `Label`, `Mark`, `Wordmark`, `Arrow`
- **App-shell pieces** live in `apps/web/src/components/shell/`:
  - `TopBar` — 56px sticky bar at the top of every internal page. Takes a `userMenu` slot for the existing `UserMenu` dropdown.
  - `OrgSidebar` / `ProjectSidebar` — 260px sticky left rail, active state derived from `usePathname`.
  - `SettingsLayout` + `Section` — sticky scroll-spy rail used by the project settings and user settings pages.
- **Tokens via Tailwind**: use `bg-paper`, `text-ink`, `border-hair`, `text-accent`, `text-energy-deep`, `bg-positive-soft`, `text-muted`, etc. The full token list is in `apps/web/src/app/globals.css` (`:root`) and mirrored to Tailwind in `apps/web/tailwind.config.ts`. **Do not** use raw `zinc-*`, `sky-*`, `amber-*`, `rose-*`, `emerald-*` — those leak the system into a generic look.
- **Squared corners.** Don't use `rounded-lg` or the default Tailwind `rounded`. The escape hatches are `rounded-sm` (4px) and `rounded-md` (6px), used only where the prototype calls for them. Dots (`rounded-full`) and avatars are the exceptions.
- **Mono for IDs and timestamps.** Run IDs, PR numbers, commit SHAs, costs, timestamps all render in `font-mono`. The system's clearest visual tell.
- **Status bus is 4 colours.** `--positive` (ok/shipped), `--accent` (active/pending action), `--energy` (warning/destructive), `--warn` (partial). Don't introduce others.
- **No emoji** in product copy.
- **No gradients** unless they're the deliberate exception the design calls for (Loop section radial accents, surfaces gate overlay).

## Working with the handoff

The source-of-truth handoff bundle (`design_handoff_mergecrew_redesign/`) has four implementation docs:

1. **00-design-system.md** — tokens + component recipes
2. **01-global-styling.md** — Tailwind config, `globals.css`, and primitives migration steps
3. **02-landing-page.md** — landing-page section-by-section recipes
4. **03-internal-app.md** — per-screen specs for every internal route (17 pages mapped 1:1 to existing files)

Plus a `prototypes/` directory with runnable React + CSS prototypes — open `prototypes/index.html` for the landing, `prototypes/internal.html` for the app. Use the prototypes as the visual + behavioural source of truth; recreate every screen in the existing Next.js codebase against the design-system primitives above.

## Status

End-to-end migration tracked under EPIC #653 and landed across PRs #680–#705 (May 2026). Subsequent polish PRs should keep these conventions in step with new pages.
