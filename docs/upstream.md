# Tracking upstream Relay

## Model

We run Relay stock. `upstream.json` pins each upstream to a release tag and to
the commit that tag pointed at when we pinned it. Every build reads the pin, so
what CI tests and what Fly runs is the same commit.

Fields per upstream:

- `repo`, `tag`, `commit`: the pin.
- `tagPattern`: which tags count as releases. It's `^vX.Y.Z$`, which skips
  prereleases and per-SDK tags such as `sdk-rust-v10.0.0`.
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

## CI on bot PRs

GitHub doesn't run workflows on PRs opened with the default `GITHUB_TOKEN`.
To get CI on bump PRs, create a GitHub App with Contents and Pull requests
read/write on this repo, then set:

- repository variable `UPSTREAM_BOT_APP_ID`
- repository secret `UPSTREAM_BOT_PRIVATE_KEY`

Without them the workflow still opens PRs, but CI won't start until someone
pushes to the branch. Either way, the repo setting "Allow GitHub Actions to
create and approve pull requests" has to be on.

## Patching (only if we must)

If we need a fix before upstream ships it, add a `git format-patch` file to
`patches/<name>/` (see [patches/README.md](../patches/README.md)). Checkout
applies patches in name order on top of the pin, so a patch that no longer
applies fails the bump PR loudly. Open an
upstream PR for every patch and delete the patch once a release includes it.
If patches start piling up, that's when to revisit a fork or subtree.
