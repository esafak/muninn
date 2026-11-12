# muninn

Named for Odin's raven of memory — it remembers what an OpenCode session ships.

Tracks what an OpenCode session ships: pull requests, issues, and CI runs —
extracted from the conversation, hydrated from the forge, and shown live in
OpenCode Desktop.

## What it looks like

Illustrations below are reconstructions rendered from the real component styles
and markup with representative data — host chrome, icons, and theme values are
approximated, not live captures.

### Composer pill

One pill per session, above the composer: `#4821 fix(tui): restore… ▾`.
Its icon and tone encode chain health and merge state.

![Closed pill above the composer](docs/screenshots/pill-closed.png)

![Composer pill dropdown: PR, issue, and run rows with a Merge button and merge options](docs/screenshots/pill.png)

Opening it shows the eligible chains with their PRs, issues, and runs. Each
open PR row carries its own Merge button — green `Merge` when it can merge
now, amber `Merge when ready` to arm Muninn's drive-by merge, a spinner while
armed. The footer holds the merge-when-ready toggle, the merge method, and
the cleanup toggles.

### Side panel

The `Muninn` tab lists the session's chains as triplet cards (issue → PR →
runs), newest activity first, grouped by day. Run rows expand to their checks.

![Muninn side panel with issue, PR, and run chains](docs/screenshots/sidebar.png)

Everything opens on the forge on click. The pin on a chain overrides the pill.

### Settings

![Muninn settings: caching, merging, and decision models](docs/screenshots/settings.png)

History retention and the debug footer, merge method / branch cleanup / status-check gating, and the decision-model judge (toggle, backend, model).

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
