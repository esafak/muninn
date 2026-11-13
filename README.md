# muninn

Named for Odin's raven of memory — it remembers what an OpenCode session ships.

Tracks what an OpenCode session ships: pull requests, issues, and CI runs —
extracted from the conversation, hydrated from the forge, and shown live in
OpenCode Desktop.

## What it looks like

**Composer pill — closed**

![Closed pill above the composer](docs/screenshots/pill-closed.png)

**Composer pill — open**

![Composer pill dropdown](docs/screenshots/pill.png)

**Side panel**

![Muninn side panel](docs/screenshots/sidebar.png)

**Settings**

![Muninn settings](docs/screenshots/settings.png)

## Decision models

Conversation extraction can find references that were only mentioned in passing.
When enabled, a decision model evaluates each candidate in context and estimates
whether it is important enough to keep in Muninn's pill and sidebar; this helps
filter incidental references without losing items that matter to the session.
Select a backend and model in Muninn's settings. Requests use credentials
already connected to OpenCode.

## Add the plugin

Install the plugin directly from its GitHub repository with OpenCode's plugin
manager. OpenCode documents the `github:owner/repo` form for `plugin add` in its
[plugin docs](https://opencode.ai/docs/plugins/#manage):

```sh
opencode plugin add github:esafak/muninn
```

To test a pull request before it merges, install its branch the same way:

```sh
opencode plugin add github:esafak/muninn#docs/readme-screenshots-settings-audit
```

Branches, tags, and full commit hashes all work.

For development and contributor guidance, see [CONTRIBUTORS.md](CONTRIBUTORS.md).
