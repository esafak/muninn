# forgescout

Tracks what an OpenCode session ships: pull requests, issues, and CI runs —
extracted from the conversation, hydrated from the forge, and shown live in
OpenCode Desktop.

Two components, one data model:

- **Composer pills** — one pair per work chain (`#4821 ✓ ready ⇢ #1043 +1` + a
  Merge pill). Appears only when the session touches sources; floats over the
  timeline, so it never resizes the composer.
- **ForgeScout side panel** — chains as triplet cards (issue → PR → runs),
  chronologically by last activity, grouped by day.

## Parts

| Export | Runtime | What it does |
|---|---|---|
| `.` | OpenCode server | Repo resolution from `git remote`, reference hydration, merge policy — behind the `ForgeScout` RPC. GitHub REST via integration credentials, `GITHUB_TOKEN`, or anonymous public access. |
| `./rpc` | both | The RPC contract — the only shared runtime token. |
| `./gui-experimental` | desktop windows | Prebuilt bundle: pills, side panel, scanning. |

## Providers

One narrow seam (`src/providers/types.ts`); the GUI renders only generic kinds
(`issue | pr | run`), statuses, and repo slugs — never provider specifics.

- **Pure, bundled into windows:** the lexicon (URL + shorthand patterns for
  session scanning) and the product mark (`src/providers/github/lexicon.ts`,
  `src/gui/marks.tsx`).
- **Server-side, dispatched by claimed host:** auth, hydration, merge settings,
  branch runs (`src/providers/github.ts`).

Adding a provider: implement `SourceProvider` + a lexicon, add both to the
registries, extend the `ProviderID` union. No UI changes.

## Develop

```sh
bun install
bun test            # bun test
bun run check       # tsc --noEmit
bun run watch       # vite build --watch → dist/gui-experimental.cjs
```

Load locally in OpenCode Desktop by adding this directory to the `plugins` array
of your global `opencode.jsonc`; rebuilds reload the GUI in every window.

Design rationale and settled decisions: `docs/design/`.
