# muninn

Named for Odin's raven of memory — it remembers what an OpenCode session ships.

Tracks what an OpenCode session ships: pull requests, issues, and CI runs —
extracted from the conversation, hydrated from the forge, and shown live in
OpenCode Desktop.

Two components, one data model:

- **Composer pills** — one pair per work chain (`#4821 ✓ ready ⇢ #1043 +1` + a
  Merge pill). Appears only when the session touches sources; floats over the
  timeline, so it never resizes the composer.
- **Muninn side panel** — chains as triplet cards (issue → PR → runs),
  chronologically by last activity, grouped by day.

## Add the plugin

Install the plugin directly from its GitHub repository with OpenCode's plugin
manager. OpenCode documents the `github:owner/repo` form for `plugin add` in its
[plugin docs](https://opencode.ai/docs/plugins/#manage):

```sh
opencode plugin add github:esafak/muninn
```

OpenCode watches configuration directories and may load the plugin automatically;
if it does not appear, restart OpenCode Desktop. See the [plugin reload
notes](https://opencode.ai/docs/plugins/#reload).

For development and contributor guidance, see [CONTRIBUTORS.md](CONTRIBUTORS.md).
