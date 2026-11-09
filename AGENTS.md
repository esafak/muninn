# Agent notes

## Project

- Upstream repository: https://github.com/anomalyco/opencode
- OpenCode GUI plugin documentation: https://opencode.ai/docs/build/plugins/gui/
- This project targets OpenCode v2.

## Commands

- `bun run check` — canonical verification (`tsc --noEmit`). Never run `tsc` with other flags.
- `bun test` — tests are colocated (`*.test.ts` beside sources), pure logic only: no network, no mocks.
- `bun run build` / `bun run watch` — the GUI bundle (`dist/gui-experimental.cjs`). The server part is
  loaded as TypeScript source; it is never built.

## Architecture rules

- `src/model.ts`, `src/rpc.ts`, `src/associate.ts`, `src/extract.ts` (core), and everything in `src/gui/`
  must stay provider-agnostic: generic kinds (`issue | pr | run`), statuses, repo slugs, and provider
  ids/marks resolved through registries. Never import a provider's network module from the GUI.
- Provider-specific code lives only in `src/providers/<name>/` (server: auth, hydration, merge settings,
  branch runs) and its lexicon (pure, bundled into windows).
- The RPC contract (`src/rpc.ts`) is the only shared runtime token between the two runtimes. Zod schemas
  there define the shapes; keep `src/model.ts` types aligned with them (zod infers mutable arrays).
- Effect `Schema` is not a dependency here; validation is zod via Standard Schema.

## Style

- `const` over `let`; early returns over `else`; no `try`/`catch` except at genuine environment
  boundaries (git subprocess, network, integration APIs).
- No `any`. Type inference over annotations; annotate only exports and literal-widening spots.
- Tests: one `describe` per function, table-ish cases, assert exact shapes.
- Commits: conventional (`feat:`, `fix:`, `docs:`, `chore:`…), no scope unless clarifying.
