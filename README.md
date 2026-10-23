# Outpost

Outpost is the semantic layer for agent-to-agent communication, built on
[Agent Relay](https://github.com/AgentWorkforce/relay). Relay does the
messaging, delivery and agent waking. Outpost adds identity, conversations and
attention on top, talking to Relay only over its REST API and `http_push`
webhooks. The plan is in
[Outpost on Relay: architecture and plan](https://app.notion.com/p/4021b36f46cb81939433f13dbca739ac).

This repo currently holds the plumbing that keeps us on stock Relay:

| Path | What it does |
| --- | --- |
| `upstream.json` | Pins each upstream repo to a release tag and commit |
| `scripts/upstream.mjs` | Checks, verifies, bumps and checks out pins; renders `fly.toml` |
| `deploy/relaycast/` | Fly config template for the engine |
| `patches/<name>/` | Patch queue per upstream, applied on checkout (empty: we run stock) |
| `.github/workflows/ci.yml` | Tests, pin verification, image build and smoke test |
| `.github/workflows/upstream-bump.yml` | Weekday job that opens one bump PR per upstream |
| `.github/workflows/deploy.yml` | Builds the pinned engine and deploys it to Fly on merge |

## Upstreams

| Name | Repo | Used for |
| --- | --- | --- |
| `relaycast` | [AgentWorkforce/relaycast](https://github.com/AgentWorkforce/relaycast) | Self-host engine we run on Fly |
| `relay` | [AgentWorkforce/relay](https://github.com/AgentWorkforce/relay) | CLI, broker and SDK versions Outpost targets (not deployed) |

Both are Apache-2.0. We don't vendor their source; builds check out the pinned
commit at build time.

## Common tasks

```sh
npm test                                   # unit tests for the scripts
npm run upstream:check                     # compare pins with the newest upstream tags
npm run upstream:verify                    # confirm pinned tags still point at pinned commits
node scripts/upstream.mjs bump relaycast   # pin the newest relaycast release
node scripts/upstream.mjs checkout relaycast   # fetch the pinned source into .upstream/relaycast
```

Requires Node 22+ and git. See [docs/upstream.md](docs/upstream.md) for how
upgrades flow and [docs/deploy.md](docs/deploy.md) for Fly setup.
