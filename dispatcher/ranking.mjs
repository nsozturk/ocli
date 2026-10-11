// The model ranking: Artificial Analysis Intelligence Index scores for the (model, reasoning level)
// pairs this machine can reach (orchestra/model-ranking.json). A ranking is an OPINION carried in
// from outside — it orders routes, it never makes an ineligible route selectable.
//
// Honesty rules (the file's `_rules`): one entry per (model, effort) exactly as AA measured it; a
// route whose (cli, model, effort) is not listed is UNRANKED (aa null), never the nearest neighbour;
// `aa` is stored and rank is derived at read time over whatever set is being compared.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** ORCHESTRA_RANKING_FILE (read per call, so tests can point it elsewhere) overrides the default: your own
 * dispatcher/model-ranking.json (gitignored), else the shipped example. */
export const rankingFile = () => (process.env.ORCHESTRA_RANKING_FILE
  ? path.resolve(process.env.ORCHESTRA_RANKING_FILE) : path.join(HERE, 'model-ranking.json'));
const exampleFile = () => path.join(HERE, 'model-ranking.example.json');

const isEffort = value => value === null || typeof value === 'string';

/** Parse and validate; throws by name on any shape it does not recognise. */
export function parseRanking(text) {
  const doc = JSON.parse(text);
  if (doc?.schemaVersion !== 1 || !Array.isArray(doc.entries)) throw new Error('model ranking: expected schemaVersion 1 with an entries array');
  const entries = doc.entries.map((entry, i) => {
    const ok = entry && typeof entry.model === 'string' && isEffort(entry.effort)
      && typeof entry.aa === 'number' && Number.isFinite(entry.aa) && Array.isArray(entry.access)
      && entry.access.every(a => a && typeof a.cli === 'string' && typeof a.modelArg === 'string' && isEffort(a.effortArg));
    if (!ok) throw new Error(`model ranking: entry ${i} is not {model, effort, aa, access[{cli, modelArg, effortArg}]}`);
    return { model: entry.model, effort: entry.effort, aa: entry.aa, creator: entry.creator ?? null, access: entry.access };
  });
  return { source: String(doc.source ?? ''), observedAt: String(doc.observedAt ?? ''), entries };
}

/** The ranking, or null when it is missing or unreadable — the caller records aa null everywhere. */
export async function loadRanking(file = rankingFile()) {
  try { return parseRanking(await readFile(file, 'utf8')); } catch (error) {
    // Only a missing own file (and no override) falls back to the shipped example.
    if (error?.code === 'ENOENT' && !process.env.ORCHESTRA_RANKING_FILE) {
      try { return parseRanking(await readFile(exampleFile(), 'utf8')); } catch { return null; }
    }
    return null;
  }
}

/** The route's effort as the ranking keys it: codex/muse/cline `effort`, opencode `variant`, agy none. */
export const routeEffort = route => route?.effort ?? route?.variant ?? null;

/** The AA score of exactly this (cli, model, effort), or null when AA did not measure it. */
export function aaFor(ranking, route) {
  if (!ranking || !route) return null;
  const effort = routeEffort(route);
  for (const entry of ranking.entries) {
    for (const access of entry.access) {
      if (access.cli === route.cli && access.modelArg === route.model && access.effortArg === effort) return entry.aa;
    }
  }
  return null;
}
