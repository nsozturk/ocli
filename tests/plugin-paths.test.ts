import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..');
const pluginFiles = () => readdirSync(join(repo, 'plugin'), { recursive: true, withFileTypes: true })
  .filter(f => f.isFile() && f.name !== '.DS_Store')
  .map(f => join(f.parentPath, f.name));

// The plugin is public: no user's home path may ride along in it, not
// even in a test constant copied from a real checkpoint.
it('no file of the plugin carries a home directory path', () => {
  const files = pluginFiles();
  expect(files.length).toBeGreaterThan(5);
  expect(files.filter(path => /\/Users\/[A-Za-z0-9._-]+\//.test(readFileSync(path, 'utf8')))).toEqual([]);
});

// An installed plugin is its folder alone, so /ocli-digest runs plugin/lib/digest.mjs. It must stay
// the dispatcher's digest byte for byte: `cp dispatcher/digest.mjs dispatcher/pane-label.mjs plugin/lib/`.
it.each(['digest.mjs', 'pane-label.mjs'])('plugin/lib/%s is byte-identical to its dispatcher/ source', name => {
  expect(readFileSync(join(repo, 'plugin', 'lib', name)).equals(readFileSync(join(repo, 'dispatcher', name)))).toBe(true);
});

// No plugin file imports, reads or runs anything above plugin/ (the marketplace caches plugin/ alone).
it('no plugin file reaches outside the plugin folder', () => {
  const hits = pluginFiles()
    .filter(path => /\.(mjs|ts|tsx|json)$/.test(path))
    .filter(path => /['"`]\.\.\/\.\.\/|\/\.\.\/dispatcher|['"`]\.\.\/(dispatcher|tests|docs|tools)\b/.test(readFileSync(path, 'utf8')));
  expect(hits).toEqual([]);
});
