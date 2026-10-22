/**
 * A3 — persistent plugin storage (the `persistent-storage` capability, ctx.storage.get/set/remove).
 *
 * Ported from CodexBar @ 6480977 (MIT, © 2026 Peter Steinberger; LICENSE-CodexBar beside the plugins):
 *   Sources/CodexBarCore/Plugins/ProviderPluginStorage.swift (format, bounds, messages),
 *   ProviderPluginRuntime.swift:159-163 (one store per provider id, only with the capability).
 * Non-secret, instance-scoped state: `<directory>/<providerId>.json` = `{"version":1,"values":{...}}`, reloaded on every
 * operation, written through a temp file + atomic rename at 0600 in a 0700 directory.
 * Node difference: CodexBar also takes a non-blocking flock on `<file>.lock` against other processes; node has no
 * flock without a dependency, so this port serializes in-process only (one plugin fetch at a time per runtime).
 */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const scriptError = message => Object.assign(new Error(message), { kind: 'script' });
const utf8Length = s => Buffer.byteLength(s, 'utf8');

function validate(values) {
  const entries = Object.entries(values);
  const total = entries.reduce((sum, [k, v]) => sum + utf8Length(k) + utf8Length(v), 0);
  if (entries.length > 64 || total > 65_536
    || !entries.every(([k, v]) => typeof v === 'string' && k.length > 0 && utf8Length(k) <= 128 && utf8Length(v) <= 16_384)) {
    throw scriptError('storage exceeds its entry or UTF-8 byte limits');
  }
}

export function createPluginStorage(directory, providerId) {
  const file = join(directory, `${providerId}.json`);
  let retired = false;

  function load() {
    let stat;
    try { stat = lstatSync(file); } catch (error) {
      if (error?.code === 'ENOENT') return Object.create(null);
      throw scriptError('invalid plugin storage file');
    }
    if (!stat.isFile() || stat.size > 400_000) throw scriptError('invalid plugin storage file');
    try {
      const payload = JSON.parse(readFileSync(file, 'utf8'));
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('shape');
      if (payload.version !== 1) throw new Error('version');
      const values = payload.values;
      if (values === null || typeof values !== 'object' || Array.isArray(values)) throw new Error('shape');
      validate(values);
      // Null prototype: a key named `__proto__` stays an ordinary entry.
      return Object.assign(Object.create(null), values);
    } catch {
      throw scriptError('invalid or incompatible plugin storage');
    }
  }

  function save(values) {
    validate(values);
    const temp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, values }), { mode: 0o600, flag: 'wx' });
      chmodSync(temp, 0o600);
      renameSync(temp, file);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
  }

  return {
    file,
    /** ProviderPluginStorage.access(_:key:value:) → the stored string, or null. */
    access(operation, key, value) {
      if (typeof key !== 'string') throw scriptError('storage key must be a string');
      if (!key || utf8Length(key) > 128) throw scriptError('storage key must contain 1-128 UTF-8 bytes');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (retired) throw scriptError('plugin storage has been removed');
      const values = load();
      switch (operation) {
        case 'get': return Object.hasOwn(values, key) ? values[key] : null;
        case 'set':
          if (typeof value !== 'string') throw scriptError('storage value must be a string');
          if (values[key] === value) return null;
          values[key] = value;
          break;
        case 'remove':
          if (!Object.hasOwn(values, key)) return null;
          delete values[key];
          break;
        default: throw scriptError('unknown storage operation');
      }
      save(values);
      return null;
    },
    /** ProviderPluginStorage.removeAll: retire the store and delete its file. */
    removeAll() {
      retired = true;
      rmSync(file, { force: true });
    },
  };
}
