# Deploying relaycast to Fly

`deploy.yml` builds the engine from the pinned upstream commit with upstream's
own Dockerfile, smoke-tests it, pushes it to `registry.fly.io/<app>`, and runs
`flyctl deploy --image`. Nothing deploys until `FLY_APP` is set, so the
workflow is a no-op until Fly is configured.

## One-time setup

```sh
fly apps create <app> --org <org>
fly volumes create relaycast_data --app <app> --region <region> --size 1
fly tokens create deploy --app <app>      # paste into FLY_API_TOKEN below
# Optional custom domain:
fly certs add <relay.example.com> --app <app>
```

Then create a GitHub environment named `production` (Settings → Environments)
with:

| Kind | Name | Example |
| --- | --- | --- |
| variable | `FLY_APP` | `outpost-relay` |
| variable | `FLY_PRIMARY_REGION` | `iad` |
| variable | `RELAYCAST_BASE_URL` | `https://outpost-relay.fly.dev` |
| secret | `FLY_API_TOKEN` | output of `fly tokens create deploy` |

`RELAYCAST_BASE_URL` must be the public https origin, with no path. The engine
won't start without it, and it mints deployment identifiers under that host,
so pick the long-term hostname before the first deploy.

Engine secrets such as `RELAYCAST_WORKSPACE_BOOTSTRAP_SECRET` go into Fly
directly (`fly secrets set ... --app <app>`), not into GitHub.

## Shape

- One `shared-cpu-1x` machine with 512 MB and a `relaycast_data` volume at
  `/data`. The self-host engine is a single Node + SQLite process and doesn't
  scale out.
- Deploy strategy is `immediate`, since Fly doesn't allow canary or bluegreen
  with volumes. Expect a short restart on each deploy.
- `auto_stop_machines = "off"`. Idempotency windows live in memory, so idle
  stops would reset them.
- Fly checks `/health` on the machine, and the workflow checks it again on the
  public URL after the deploy.

## Manual deploy or rollback

Run the Deploy workflow from the Actions tab to redeploy the current pin. To
roll back, pin an older tag (`bump relaycast --to vX.Y.Z`) and merge. Read the
migration note in [upstream.md](upstream.md) first.
