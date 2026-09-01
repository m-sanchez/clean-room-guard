import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('the package has no runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined, 'a scanner you install before publishing should add nothing');
  assert.equal(pkg.peerDependencies, undefined);
});

test('the published tarball carries what the entry points name', () => {
  for (const entry of [pkg.bin['clean-room-guard'], pkg.exports['.']]) {
    const top = entry.replace(/^\.\//, '').split('/')[0];
    assert.ok(pkg.files.includes(top), `${entry} is not covered by "files"`);
  }
});

test('the git-tag install line in the README names the version being published', () => {
  const tag = `#v${pkg.version}`;
  assert.ok(
    readme.includes(tag),
    `README offers an install from a tag other than ${tag}; a stale pin installs the wrong scanner`
  );
});
