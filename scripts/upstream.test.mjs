import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  assertBaseUrl,
  attentionChanges,
  bumpLevel,
  changelogExcerpt,
  latestTag,
  parseLsRemote,
  parseVersion,
  renderTemplate,
  watchedChanges,
} from './upstream.mjs';

const PATTERN = '^v(\\d+)\\.(\\d+)\\.(\\d+)$';

test('parseVersion only accepts tags matching the pattern', () => {
  assert.deepEqual(parseVersion('v11.0.0', PATTERN), [11, 0, 0]);
  assert.equal(parseVersion('sdk-rust-v10.0.0', PATTERN), null);
  assert.equal(parseVersion('v11.0.0-rc.1', PATTERN), null);
});

test('parseLsRemote prefers peeled commits for annotated tags', () => {
  const tags = parseLsRemote(
    [
      'e15a14134a5ce9edf3f72430ab4b516a880dd610\trefs/tags/v11.0.0',
      '752d660a9ba6cdb7d1fe692a9fd35621f45f1590\trefs/tags/v11.0.0^{}',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v10.6.5',
    ].join('\n'),
  );
  assert.equal(tags.get('v11.0.0'), '752d660a9ba6cdb7d1fe692a9fd35621f45f1590');
  assert.equal(tags.get('v10.6.5'), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});

test('latestTag sorts numerically and ignores non-release tags', () => {
  const tags = new Map([
    ['v10.6.5', 'a'],
    ['v10.10.0', 'b'],
    ['v9.99.99', 'c'],
    ['sdk-rust-v99.0.0', 'd'],
  ]);
  assert.equal(latestTag(tags, PATTERN).tag, 'v10.10.0');
});

test('bumpLevel classifies upgrades', () => {
  assert.equal(bumpLevel([10, 6, 5], [11, 0, 0]), 'major');
  assert.equal(bumpLevel([11, 0, 0], [11, 1, 0]), 'minor');
  assert.equal(bumpLevel([11, 0, 0], [11, 0, 3]), 'patch');
  assert.equal(bumpLevel([11, 0, 0], [11, 0, 0]), 'none');
  assert.equal(bumpLevel([11, 0, 0], [10, 0, 0]), 'none');
});

test('changelogExcerpt keeps only versions in (from, to]', () => {
  const md = [
    '# Changelog',
    '## [Unreleased]',
    '- pending',
    '## [11.0.0] - 2026-10-22',
    '- big change',
    '## [10.6.5] - 2026-10-21',
    '- fix',
    '## [10.6.4] - 2026-10-20',
    '- older',
  ].join('\n');
  const excerpt = changelogExcerpt(md, [10, 6, 4], [11, 0, 0]);
  assert.match(excerpt, /### \[11\.0\.0\]/);
  assert.match(excerpt, /### \[10\.6\.5\]/);
  assert.doesNotMatch(excerpt, /older|pending/);
});

test('watchedChanges matches path prefixes and exact files', () => {
  const files = ['Dockerfile', 'docker/entrypoint.mjs', 'packages/engine/src/x.ts', 'site/index.md'];
  assert.deepEqual(watchedChanges(files, ['Dockerfile', 'docker/', 'packages/engine/']), files.slice(0, 3));
  assert.deepEqual(watchedChanges(['packages/engine/src/__tests__/a.test.ts'], ['packages/engine/']), []);
});

test('attentionChanges flags migrations and build inputs', () => {
  const files = ['packages/engine/src/db/migrations/0075_fts.sql', 'Dockerfile', 'packages/engine/src/engine.ts'];
  assert.deepEqual(attentionChanges(files, ['/migrations/', '^Dockerfile$']), files.slice(0, 2));
});

test('renderTemplate reports every missing variable', () => {
  assert.equal(renderTemplate('a=${A}', { A: '1' }), 'a=1');
  assert.throws(() => renderTemplate('${A} ${B} ${B}', {}), /Missing environment variables: A, B$/);
});

test('assertBaseUrl mirrors the upstream entrypoint rules', () => {
  assert.equal(assertBaseUrl('https://relay.example.com/'), 'https://relay.example.com');
  assert.throws(() => assertBaseUrl('http://relay.example.com'), /https/);
  assert.throws(() => assertBaseUrl('https://relay.example.com/api'), /origin only/);
  assert.throws(() => assertBaseUrl('https://localhost'), /two DNS labels/);
});

test('upstream.json pins are well formed', () => {
  const manifest = JSON.parse(readFileSync(new URL('../upstream.json', import.meta.url), 'utf8'));
  for (const [name, upstream] of Object.entries(manifest.upstreams)) {
    assert.match(upstream.repo, /^[\w.-]+\/[\w.-]+$/, `${name}.repo`);
    assert.match(upstream.commit, /^[0-9a-f]{40}$/, `${name}.commit`);
    assert.ok(parseVersion(upstream.tag, upstream.tagPattern), `${name}.tag matches tagPattern`);
    assert.ok(Array.isArray(upstream.watchPaths), `${name}.watchPaths`);
  }
});
