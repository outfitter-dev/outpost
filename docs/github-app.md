# Upstream bot GitHub App

`upstream-bump.yml` and `fork-sync.yml` act as a GitHub App rather than with
the default `GITHUB_TOKEN`, for two reasons:

1. GitHub does not start workflows for PRs or pushes made with
   `GITHUB_TOKEN`, so bump PRs would never get CI.
2. `GITHUB_TOKEN` only reaches the repo the workflow runs in, and fork-sync has
   to write to `outfitter-dev/agentrelay`.

Without the app, upstream-bump still opens PRs (with no CI), and fork-sync
skips.

## 1. Create the app

Go to **outfitter-dev → Settings → Developer settings → GitHub Apps → New GitHub
App**: <https://github.com/organizations/outfitter-dev/settings/apps/new>

| Field | Value |
| --- | --- |
| GitHub App name | `outpost-upstream` (anything unique on GitHub) |
| Homepage URL | `https://github.com/outfitter-dev/outpost` |
| Callback URL, Setup URL | leave empty |
| Request user authorization (OAuth) during installation | off |
| Webhook → Active | **off** (the workflows call the API; nothing listens for events) |
| Where can this GitHub App be installed? | **Only on this account** |

**Repository permissions** (leave everything else at "No access"):

| Permission | Access | Why |
| --- | --- | --- |
| Contents | Read and write | Push `upstream/<name>` branches here; create `sync/<tag>` and run merge-upstream on the fork |
| Pull requests | Read and write | Open and update the bump PRs and fork sync PRs |
| Issues | Read and write | Create and apply the `upstream` / `upstream:<level>` labels (labels live under Issues) |
| Workflows | Read and write | `sync/<tag>` and the fork's `main` sync carry upstream's `.github/workflows` changes, and GitHub rejects ref updates that touch workflow files without this |
| Metadata | Read-only | Required; selected automatically |

**Organization** and **Account** permissions: none.

Click **Create GitHub App**.

## 2. Collect the credentials

On the app's settings page:

- Copy the **Client ID** (it looks like `Iv23li…`). It is not secret.
- Under **Private keys**, click **Generate a private key**. A `.pem` file
  downloads. That file is the secret, so keep it out of chat and out of the repo.

## 3. Install it on both repos

On the app's page, open **Install App**, choose **outfitter-dev**, select
**Only select repositories**, and pick:

- `outfitter-dev/outpost`
- `outfitter-dev/agentrelay`

## 4. Add the variable and secret to outpost

In **outfitter-dev/outpost → Settings → Secrets and variables → Actions**:

| Tab | Name | Value |
| --- | --- | --- |
| Variables | `UPSTREAM_BOT_CLIENT_ID` | the Client ID |
| Secrets | `UPSTREAM_BOT_PRIVATE_KEY` | the whole `.pem` contents, including the `-----BEGIN`/`END-----` lines |

Or from a terminal:

```sh
gh variable set UPSTREAM_BOT_CLIENT_ID --repo outfitter-dev/outpost --body 'Iv23li...'
gh secret set UPSTREAM_BOT_PRIVATE_KEY --repo outfitter-dev/outpost < ~/Downloads/outpost-upstream.*.private-key.pem
```

Then delete the downloaded `.pem`, or move it into your password manager.

## 5. Repo settings

- **outfitter-dev/outpost → Settings → Actions → General → Workflow
  permissions**: enable **Allow GitHub Actions to create and approve pull
  requests**. This is only needed for the `GITHUB_TOKEN` fallback, but it's
  harmless to leave on.
- **outfitter-dev/agentrelay → Actions**: forks start with Actions disabled.
  Enable them only if you want upstream's own CI to run on `outpost` PRs.
  Fork-sync runs from outpost and doesn't need it.

## 6. Check it works

Run **Actions → Fork sync → Run workflow** and **Actions → Upstream bump → Run
workflow** in outpost. While everything is current, both should finish green
with nothing to do. The fork-sync summary should not say "skipping", and the
"Mint app token" steps should run instead of being skipped. (In fork-sync, the
token step only runs when a sync is needed.)

## Rotating the key

Generate a new private key on the app page, update `UPSTREAM_BOT_PRIVATE_KEY`,
then delete the old key on the app page.
