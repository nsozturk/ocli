import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The plugin is public: no user's home path may ride along in it, not
// even in a test constant copied from a real checkpoint.
it('no file of the plugin carries a home directory path', () => {
  const root = join(import.meta.dirname, '..', 'plugin');
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter(f => f.isFile());
  expect(files.length).toBeGreaterThan(5);
  const hits = files
    .map(f => join(f.parentPath, f.name))
    .filter(path => /\/Users\/[A-Za-z0-9._-]+\//.test(readFileSync(path, 'utf8')));
  expect(hits).toEqual([]);
});
