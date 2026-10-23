# Tracking upstream Relay

## Model

Relaycast runs stock. The relay broker carries our changes (new harness
adapters), which live on the `outpost` branch of our fork,
[outfitter-dev/agentrelay](https://github.com/outfitter-dev/agentrelay). See
[Forked upstreams](#forked-upstreams). `upstream.json` pins each upstream to a release tag and to
the commit that tag pointed at when we pinned it. Every build reads the pin, so
what CI tests and what Fly runs is the same commit.

Fields per upstream:

- `repo`, `tag`, `commit`: the pin.
- `tagPattern`: which tags count as releases. It's `^vX.Y.Z$`, which skips
  prereleases and per-SDK tags such as `sdk-rust-v10.0.0`.
- `fork` (optional): `repo`, `branch`, `commit`. When set, builds use
  `fork.commit`, and `tag`/`commit` name the newest upstream release merged
  into it. `verify` checks that claim.
- `deploy`: the directory under `deploy/` that builds and ships it, or `null`.
- `watchPaths`: path prefixes listed in bump PRs (tests excluded).
- `attentionPatterns`: regexes that put a file in a "review before merging"
  callout: DB migrations, image build inputs, the API contract.

## How an upgrade flows

1. On weekdays `upstream-bump.yml` checks each upstream for a newer release tag.
2. If there is one, it rewrites the pin on `upstream/<name>`, force-pushes, and
   opens or updates a single PR. Several upstream releases in a day still end
   up as one PR pinned to the newest tag.
3. The PR body has the compare link, the changed files under watched paths,
   flagged migrations and build changes, and the upstream changelog excerpt.
   Major bumps get a warning and the `upstream:major` label.
4. CI runs `verify`, builds the engine image from the pinned commit, and
   smoke-tests `/health`.
5. Merging to `main` triggers `deploy.yml`, which rebuilds the image, pushes it
   to Fly's registry and deploys it.

To pin a specific version, run the workflow by hand with `to: vX.Y.Z`, or
locally `node scripts/upstream.mjs bump relaycast --to vX.Y.Z`. Rolling back
works the same way: pin the older tag and merge.

### Database migrations

The engine runs SQLite migrations on boot against the Fly volume. Treat a bump
that flags `migrations/` as one-way. Before merging, snapshot the volume
(`fly volumes snapshots create <vol-id>`) so a rollback can restore data and
not just code.

## Forked upstreams

For relay, the fork's `outpost` branch is the source of truth, and our work
lands there through normal PRs in the fork. Two jobs keep it moving:

1. **`fork-sync.yml`** (here, on weekdays) checks whether the newest upstream
   release is merged into `outpost`. If it isn't, it syncs the fork's `main`
   with upstream, creates `sync/<tag>` at the release commit, and opens a PR
   in the fork from `sync/<tag>` into `outpost`. GitHub shows whether it
   merges cleanly. Resolve conflicts on that branch and merge **with a merge
   commit**. We merge upstream in and never rebase `outpost`, so in-flight
   work isn't disrupted and a conflict only gets resolved once.
2. **`upstream-bump.yml`** follows the fork branch head. When `outpost` moves
   (a sync merged, or one of our changes landed), it opens the pin PR here. The
   PR's level is the upstream bump (`major`/`minor`/`patch`), or `fork` when
   only our commits changed.

To see what we carry on top of upstream, compare the release with the fork:
`https://github.com/outfitter-dev/agentrelay/compare/<tag>...outpost`. Send
self-contained adapters upstream as PRs when they're general enough, since
every one upstream accepts is one less thing to merge forward.

The fork has GitHub Actions disabled by default. Turn them on (fork Settings →
Actions) if you want upstream's own test suite to run on `outpost` PRs.

## CI on bot PRs

GitHub doesn't run workflows on PRs opened with the default `GITHUB_TOKEN`.
To get CI on bump PRs, and to let fork-sync write to the fork at all, the
workflows use a GitHub App. [github-app.md](github-app.md) has the exact
settings and permissions.

Without it, upstream-bump still opens PRs, but CI won't start until someone
pushes to the branch, and fork-sync skips.

## Patching (only if we must)

If we need a fix before upstream ships it, add a `git format-patch` file to
`patches/<name>/` (see [patches/README.md](../patches/README.md)). Checkout
applies patches in name order on top of the pin, so a patch that no longer
applies fails the bump PR loudly. Open an
upstream PR for every patch and delete the patch once a release includes it.
Patches suit a stock upstream like relaycast. Anything bigger belongs on a fork,
the way relay works.
