# How the profile card is built

The card is a single SVG rendered from [`config.json`](../config.json) by
[`scripts/generate-card.js`](../scripts/generate-card.js), and refreshed daily by
[a workflow](../.github/workflows/update-card.yml).

**Editing it.** Everything visible is in `config.json` — rows are `["Label", "value"]`
pairs grouped into sections, and the layout recomputes around whatever you put
there. A four-element row (`["Repos", "...", "Stars", "..."]`) renders as a
paired row split by a `|` tower.

**Live values.** `{{token}}` is substituted at build time; single braces stay
literal, so `"{{repos}} {Contributed: {{contributed}}}"` keeps its outer pair.

| token | value |
| --- | --- |
| `{{uptime}}` | age from `birthday`, as years / months / days |
| `{{repos}}` `{{contributed}}` | owned repo count (see `include_private`), repos contributed to |
| `{{stars}}` `{{followers}}` | stars across those same repos, follower count |
| `{{commits}}` | all-time commits, private contributions included |
| `{{loc}}` | net lines with coloured `++` / `--` breakdown |
| `{{private}}` | private repo count (needs `include_private`) |
| `{{username}}` `{{year}}` | GitHub handle, current year |

**Previewing locally.** `npm run preview` renders with placeholder stats and no
network, which is the fast loop for design changes:

```sh
npm run preview     # -> generated/profile-card.svg
npm run build       # real stats, needs GH_TOKEN
```

**Setup.** The workflow needs a repo secret named `CARD_TOKEN` — a PAT with
`repo` and `read:user`. The built-in `GITHUB_TOKEN` is scoped to this repo alone
and can't clone the others to count lines.

**Private repos.** `github.include_private` in `config.json` decides whether
private repos feed `{{repos}}`, `{{stars}}` and `{{loc}}`. Commits ignore this
flag — `contributionsCollection` reports private commits as
`restrictedContributionsCount`, which is always added in, provided
*Settings -> Profile -> Include private contributions on my profile* is enabled.

Turning it on publishes aggregate signal about private work (how many repos, how
many lines) but never names or code. Two details make that safe: the LOC cache is
keyed by a hash of each repo name rather than the name itself, so this public repo
never lists private repo names, and clone failures log `<private repo>` instead of
the name, since Actions logs on a public repo are public too.

**Line counting.** Additions and deletions come from `git log --numstat` over a
bare clone of every owned repo. Results are cached in `generated/loc-cache.json`
against each repo's HEAD sha, so a repo that hasn't been pushed to since the last
run is never cloned again — otherwise the daily job would re-clone the whole
account every morning.

**Excluding vendored code.** `github.exclude_paths` is a list of globs kept out
of the line count, passed to git as pathspecs. It matters more than it sounds:
with `node_modules` committed in one repo, 68% of the original count was lodash
and `@types/node` rather than anything hand-written. The active exclusion list is
fingerprinted into the cache, so editing it recounts every repo instead of
serving stale totals. `github.exclude_repos` drops whole repos the same way.

**Alignment.** The card is a monospace grid. Each row's dot leader is sized from
a shared `targetWidth` measured across every row, so values stay flush to one
right edge no matter how long a label or value gets.
