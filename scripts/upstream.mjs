#!/usr/bin/env node
// Upstream pin manager for Outpost.
//
// upstream.json pins each upstream Relay repo to a release tag and the commit
// that tag pointed at when we pinned it. Everything that builds or deploys
// upstream code reads the pin from there, so a deploy is reproducible and an
// upgrade is a one-file diff.
//
//   node scripts/upstream.mjs check [--json]
//   node scripts/upstream.mjs verify
//   node scripts/upstream.mjs bump <name> [--to <tag>] [--body-file <path>]
//   node scripts/upstream.mjs checkout <name> [--dir <path>] [--no-patches]
//   node scripts/upstream.mjs fly-config <name> [--out <path>]
//
// No dependencies: Node >= 22 and git on PATH. Upstreams are public, so no token is needed.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'upstream.json');

// ---------------------------------------------------------------------------
// Pure helpers (covered by upstream.test.mjs)
// ---------------------------------------------------------------------------

/** Parse a tag into [major, minor, patch] using the upstream's tagPattern, or null. */
export function parseVersion(tag, pattern) {
  const match = new RegExp(pattern).exec(tag);
  if (!match || match.length < 4) return null;
  return match.slice(1, 4).map(Number);
}

export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Turn `git ls-remote --tags` output into a Map of tag -> commit SHA (peeled for annotated tags). */
export function parseLsRemote(output) {
  const tags = new Map();
  for (const line of output.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref?.startsWith('refs/tags/')) continue;
    const name = ref.slice('refs/tags/'.length);
    if (name.endsWith('^{}')) {
      // The peeled entry is the commit; it wins over the tag object SHA.
      tags.set(name.slice(0, -3), sha);
    } else if (!tags.has(name)) {
      tags.set(name, sha);
    }
  }
  return tags;
}

/** Highest tag matching the pattern, or null. */
export function latestTag(tags, pattern) {
  let best = null;
  for (const [tag, commit] of tags) {
    const version = parseVersion(tag, pattern);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, commit, version };
  }
  return best;
}

export function bumpLevel(from, to) {
  if (compareVersions(to, from) <= 0) return 'none';
  if (to[0] !== from[0]) return 'major';
  if (to[1] !== from[1]) return 'minor';
  return 'patch';
}

/**
 * Keep-a-Changelog excerpt for versions in (from, to]. Upstream headings look
 * like `## [11.0.0] - 2026-10-22`; anything unparseable is skipped.
 */
export function changelogExcerpt(markdown, from, to) {
  const lines = markdown.split('\n');
  const out = [];
  let keep = false;
  for (const line of lines) {
    const heading = /^## \[(\d+)\.(\d+)\.(\d+)\]/.exec(line);
    if (heading) {
      const version = heading.slice(1, 4).map(Number);
      keep = compareVersions(version, from) > 0 && compareVersions(version, to) <= 0;
    } else if (/^## /.test(line)) {
      keep = false;
    }
    if (keep) out.push(line.replace(/^## /, '### '));
  }
  return out.join('\n').trim();
}

/** Files from a compare that touch any watched path prefix. */
export function watchedChanges(files, watchPaths) {
  return files.filter(
    (file) => !/(^|\/)(__tests__|tests?)\//.test(file) && watchPaths.some((prefix) => file === prefix || file.startsWith(prefix)),
  );
}

/** Files matching any attention regex (DB migrations, image build inputs, API contract). */
export function attentionChanges(files, patterns) {
  const regexes = patterns.map((pattern) => new RegExp(pattern));
  return files.filter((file) => regexes.some((regex) => regex.test(file)));
}

/** Replace ${VAR} placeholders; throws listing every variable that is unset. */
export function renderTemplate(template, env) {
  const missing = new Set();
  const rendered = template.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const value = env[name];
    if (value === undefined || value === '') {
      missing.add(name);
      return '';
    }
    return value;
  });
  if (missing.size) throw new Error(`Missing environment variables: ${[...missing].join(', ')}`);
  return rendered;
}

/** Render an upstream-controlled string as inert inline code in the PR body. */
export function codeSpan(text) {
  const clean = String(text).replace(/[\u0000-\u001f`]/g, '?');
  return `\`${clean}\``;
}

/** Fly app names and region codes are interpolated into TOML strings; allow only their real shapes. */
export function assertFlyIdentifiers(env) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(env.FLY_APP ?? '')) throw new Error('FLY_APP must be a Fly app name (lowercase letters, digits, hyphens)');
  if (!/^[a-z]{3}$/.test(env.FLY_PRIMARY_REGION ?? '')) throw new Error('FLY_PRIMARY_REGION must be a three-letter Fly region code');
}

/** Mirrors the upstream entrypoint's --base-url rules so a bad value fails before deploy. */
export function assertBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('RELAYCAST_BASE_URL must use https');
  if (url.origin !== value.replace(/\/$/, '')) throw new Error('RELAYCAST_BASE_URL must be an origin only (no path, query or credentials)');
  if (!url.hostname.includes('.')) throw new Error('RELAYCAST_BASE_URL hostname needs at least two DNS labels');
  return url.origin;
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

function writeManifest(manifest) {
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function getUpstream(manifest, name) {
  const upstream = manifest.upstreams[name];
  if (!upstream) throw new Error(`Unknown upstream "${name}". Known: ${Object.keys(manifest.upstreams).join(', ')}`);
  return upstream;
}

function remoteTags(repo) {
  const output = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`], { encoding: 'utf8' });
  return parseLsRemote(output);
}

function setOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else flags[key] = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function check({ flags }) {
  const manifest = readManifest();
  const rows = Object.entries(manifest.upstreams).map(([name, upstream]) => {
    const latest = latestTag(remoteTags(upstream.repo), upstream.tagPattern);
    const pinned = parseVersion(upstream.tag, upstream.tagPattern);
    return {
      name,
      pinned: upstream.tag,
      latest: latest?.tag ?? null,
      level: latest ? bumpLevel(pinned, latest.version) : 'none',
    };
  });
  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    for (const row of rows) {
      const status = row.level === 'none' ? 'up to date' : `${row.level} update available: ${row.latest}`;
      console.log(`${row.name.padEnd(12)} ${row.pinned.padEnd(10)} ${status}`);
    }
  }
}

function verify() {
  const manifest = readManifest();
  let failed = false;
  for (const [name, upstream] of Object.entries(manifest.upstreams)) {
    const commit = remoteTags(upstream.repo).get(upstream.tag);
    if (!parseVersion(upstream.tag, upstream.tagPattern)) {
      console.error(`✗ ${name}: tag ${upstream.tag} does not match tagPattern`);
      failed = true;
    } else if (!commit) {
      console.error(`✗ ${name}: tag ${upstream.tag} no longer exists upstream`);
      failed = true;
    } else if (commit !== upstream.commit) {
      console.error(`✗ ${name}: ${upstream.tag} now points at ${commit}, pinned ${upstream.commit} (upstream re-tagged?)`);
      failed = true;
    } else {
      console.log(`✓ ${name}: ${upstream.tag} @ ${commit.slice(0, 12)}`);
    }
  }
  if (failed) process.exit(1);
}

async function bump({ positional, flags }) {
  const [name] = positional;
  if (!name) throw new Error('Usage: bump <name> [--to <tag>] [--body-file <path>]');
  const manifest = readManifest();
  const upstream = getUpstream(manifest, name);
  const tags = remoteTags(upstream.repo);

  let target;
  if (typeof flags.to === 'string') {
    const commit = tags.get(flags.to);
    const version = parseVersion(flags.to, upstream.tagPattern);
    if (!commit || !version) throw new Error(`Tag ${flags.to} not found upstream or does not match tagPattern`);
    target = { tag: flags.to, commit, version };
  } else {
    target = latestTag(tags, upstream.tagPattern);
  }

  const fromVersion = parseVersion(upstream.tag, upstream.tagPattern);
  const level = target ? bumpLevel(fromVersion, target.version) : 'none';
  const samePin = target && target.tag === upstream.tag && target.commit === upstream.commit;
  if (!target || samePin || (level === 'none' && typeof flags.to !== 'string')) {
    console.log(`${name} is up to date at ${upstream.tag}`);
    setOutput({ changed: 'false' });
    return;
  }

  const from = upstream.tag;
  const fromCommit = upstream.commit;
  upstream.tag = target.tag;
  upstream.commit = target.commit;
  writeManifest(manifest);
  console.log(`${name}: ${from} -> ${target.tag} (${level})`);

  if (flags['body-file']) {
    const body = await prBody({ name, upstream, from, fromCommit, fromVersion, target, level });
    writeFileSync(flags['body-file'], body);
  }
  setOutput({ changed: 'true', from, to: target.tag, level });
}

async function prBody({ name, upstream, from, fromCommit, fromVersion, target, level }) {
  const compareUrl = `https://github.com/${upstream.repo}/compare/${from}...${target.tag}`;
  const lines = [
    `Bumps **${name}** (\`${upstream.repo}\`) from \`${from}\` to \`${target.tag}\` (${level}).`,
    '',
    `Commit: \`${target.commit}\` · [Compare](${compareUrl})`,
    '',
  ];

  if (level === 'major') {
    lines.push('> [!WARNING]', '> Major version. Read the changelog for breaking changes before merging.', '');
  }

  try {
    const { files, changelog } = diffUpstream(upstream.repo, fromCommit, target.commit);
    const watched = watchedChanges(files, upstream.watchPaths ?? []);
    const attention = attentionChanges(files, upstream.attentionPatterns ?? []);
    lines.push(`**${files.length} files changed.**`, '');
    if (attention.length) {
      lines.push('> [!IMPORTANT]', '> Review before merging. These touch the database schema, the image build, or the API contract:', '>');
      for (const file of attention) lines.push(`> - ${codeSpan(file)}`);
      lines.push('');
    }
    if (watched.length) {
      lines.push('<details><summary>Changes under watched paths (tests excluded)</summary>', '');
      for (const file of watched.slice(0, 50)) lines.push(`- ${codeSpan(file)}`);
      if (watched.length > 50) lines.push(`- …and ${watched.length - 50} more`);
      lines.push('', '</details>', '');
    } else {
      lines.push('No changes under watched paths.', '');
    }
    const excerpt = changelog ? changelogExcerpt(changelog, fromVersion, target.version) : '';
    if (excerpt) {
      lines.push('<details><summary>Upstream changelog</summary>', '', excerpt, '', '</details>', '');
    }
  } catch (error) {
    lines.push(`_Could not diff upstream: ${error.message.split('\n')[0]}_`, '');
  }

  if (upstream.deploy) {
    lines.push(`Merging deploys \`${upstream.deploy}\` to Fly from this pin.`);
  } else {
    lines.push('This upstream is not deployed; the pin tracks the SDK/CLI version Outpost targets.');
  }
  lines.push('', '_Opened by the upstream-bump workflow._');
  return `${lines.join('\n')}\n`;
}

/**
 * Changed files and the new CHANGELOG.md between two upstream commits, using a
 * blobless shallow fetch of just those two commits (no API, no file-count cap).
 */
function diffUpstream(repo, fromCommit, toCommit) {
  const dir = mkdtempSync(join(tmpdir(), 'outpost-upstream-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q');
    git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
    git('fetch', '-q', '--depth', '1', '--filter', 'blob:none', 'origin', fromCommit, toCommit);
    const files = git('diff', '--name-only', fromCommit, toCommit).split('\n').filter(Boolean);
    let changelog = '';
    try {
      changelog = git('show', `${toCommit}:CHANGELOG.md`);
    } catch {
      // Upstream without a root changelog: skip the excerpt.
    }
    return { files, changelog };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkout({ positional, flags }) {
  const [name] = positional;
  if (!name) throw new Error('Usage: checkout <name> [--dir <path>] [--no-patches]');
  const upstream = getUpstream(readManifest(), name);
  const dir = resolve(typeof flags.dir === 'string' ? flags.dir : join(ROOT, '.upstream', name));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'inherit' });

  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    git('init', '-q');
    git('remote', 'add', 'origin', `https://github.com/${upstream.repo}.git`);
  }
  git('fetch', '-q', '--depth', '1', 'origin', upstream.commit);
  git('-c', 'advice.detachedHead=false', 'checkout', '-q', '--force', upstream.commit);
  git('clean', '-q', '-fdx');
  console.log(`${name} ${upstream.tag} @ ${upstream.commit.slice(0, 12)} -> ${dir}`);

  if (flags['no-patches']) return;
  const patchDir = join(ROOT, 'patches', name);
  const patches = existsSync(patchDir) ? readdirSync(patchDir).filter((file) => file.endsWith('.patch')).sort() : [];
  for (const patch of patches) {
    console.log(`  applying patches/${name}/${patch}`);
    git('apply', '--index', join(patchDir, patch));
  }
}

function flyConfig({ positional, flags }) {
  const [name] = positional;
  if (!name) throw new Error('Usage: fly-config <name> [--out <path>]');
  const upstream = getUpstream(readManifest(), name);
  if (!upstream.deploy) throw new Error(`${name} has no deploy target`);
  const template = readFileSync(join(ROOT, 'deploy', upstream.deploy, 'fly.template.toml'), 'utf8');
  const env = { ...process.env, UPSTREAM_TAG: upstream.tag, UPSTREAM_COMMIT: upstream.commit };
  assertFlyIdentifiers(env);
  if (!env.RELAYCAST_BASE_URL) throw new Error('Missing environment variables: RELAYCAST_BASE_URL');
  env.RELAYCAST_BASE_URL = assertBaseUrl(env.RELAYCAST_BASE_URL);
  const rendered = renderTemplate(template, env);
  if (typeof flags.out === 'string') writeFileSync(flags.out, rendered);
  else process.stdout.write(rendered);
}

const COMMANDS = { check, verify, bump, checkout, 'fly-config': flyConfig };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const run = COMMANDS[command];
  if (!run) {
    console.error(`Usage: upstream.mjs <${Object.keys(COMMANDS).join('|')}> ...`);
    process.exit(2);
  }
  try {
    await run(parseArgs(rest));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
