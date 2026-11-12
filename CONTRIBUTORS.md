# Contributor guide

Development notes for contributors to Muninn. User-facing setup and usage are
in [README.md](README.md).

## Development commands

- `bun install` — install dependencies.
- `bun test` — run colocated pure-logic tests (`*.test.ts`); tests do not use
  network access or mocks.
- `bun run check` — canonical verification (`tsc --noEmit`). Do not run `tsc`
  with other flags.
- `bun run build` / `bun run watch` — build or watch the GUI bundle at
  `dist/gui-experimental.cjs`. The server is loaded as TypeScript source and is
  not built.

## Load a local checkout

To develop against this checkout in OpenCode Desktop, add its absolute
directory path to the `plugins` array in the global config at
`~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "plugins": ["/absolute/path/to/muninn"]
}
```

Replace the example with this checkout's path. If you installed Muninn from
GitHub, replace that plugin entry with the local path rather than loading both.
Run `bun run watch` to rebuild the GUI bundle; each rebuild reloads the GUI in
every window. Server source changes require restarting the server.

## Architecture

- Package exports: `.` is the OpenCode server plugin, `./rpc` is the shared
  contract, and `./gui-experimental` is the prebuilt desktop-window bundle.
  The server resolves repositories from `git remote`, hydrates references, and
  applies merge policy through the Muninn RPC. GitHub REST uses integration
  credentials, `GITHUB_TOKEN`, or anonymous access for public repositories.
- `src/model.ts`, `src/rpc.ts`, `src/associate.ts`, `src/extract.ts` (core), and
  everything in `src/gui/` must remain provider-agnostic: generic kinds
  (`issue | pr | run`), statuses, repo slugs, and provider IDs/marks resolved
  through registries. Never import a provider's network module from the GUI.
- Provider-specific code belongs in `src/providers/<name>/`: server-side auth,
  hydration, merge settings, branch runs, and a pure lexicon bundled into
  windows.
- `src/rpc.ts` is the only shared runtime contract. Keep `src/model.ts` aligned
  with its Zod schemas (which infer mutable arrays).
- Validation uses Zod via Standard Schema; Effect `Schema` is not a dependency.

## Providers

The provider seam is `src/providers/types.ts`. The GUI renders generic kinds
(`issue | pr | run`), statuses, and repo slugs, never provider-specific data.
Provider lexicons (URL and shorthand patterns for session scanning) and product
marks are pure and bundled into windows; auth, hydration, merge settings, and
branch runs are server-side and dispatched by claimed host.

To add a provider, implement `SourceProvider` and a lexicon, register both, and
extend the `ProviderID` union. No UI changes should be needed.

## Style

- Prefer `const` and early returns. Use `try`/`catch` only at genuine environment
  boundaries (git subprocesses, network, integration APIs).
- Avoid `any`; prefer inference, annotating exports and literal-widening spots.
- Tests: one `describe` per function, table-like cases, and exact-shape asserts.
- Commits use conventional prefixes (`feat:`, `fix:`, `docs:`, `chore:`…),
  without a scope unless it clarifies.
