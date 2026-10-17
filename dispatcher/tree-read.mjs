// Recorded tree readings only: no provider calls or budget reporting.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { budget as budgetRows, ROUTE_LIMIT_IDS, bindingWindow } from './usage.mjs';

/** Which budget row a recorded node belongs to. `null` = not a developer dispatch we account for. */
export function providerForNode(node) {
  if (node?.role === 'lead-correction') return null; // the lead's annotation on a node, not a run
  if (node?.cli === 'codex') return 'codex';
  if (node?.cli === 'opencode' && String(node.model ?? '').startsWith('zai-coding-plan/')) return 'glm';
  if (node?.cli === 'claude' || node?.cli === 'claude-agent' || node?.cli === 'claude-code') return 'claude';
  if (node?.cli === 'agy') return 'gemini';
  if (node?.cli === 'cline') return 'cline'; // Cline Pass: no budget row, no readable counter yet
  return null;
}

/** Which billing pool a recorded node can declare a window stop for. Derived from
 * providerForNode, never from the role: cline passes through, while the budget namespace's
 * `glm` IS the ZAI billing pool (opencode zai-coding-plan/*), so stops say `zai`. A stop
 * needs no budget row — the provider's own verdict binds uncapped pools too. */
export function stopProviderForNode(node) {
  const provider = providerForNode(node);
  if (provider === 'cline') return 'cline';
  if (provider === 'glm') return 'zai';
  return null;
}

/**
 * Newest provider-declared stop for a pool, or null when there is none or a later successful
 * run of that pool cleared it. Ordering matches latestReading (max by recordedAt; the later
 * line wins a tie; a missing recordedAt sorts oldest). A stop-bearing node only ever
 * competes as a stop, and a failed run without one competes as neither: only a real
 * success (exit 0 without blocked) clears — an exit-0 run the CLI itself refused stays
 * stopped. Expiry (resetsAt vs now) is the caller's decision, not this scan's.
 */
export function latestProviderStop(nodes, stopProvider) {
  if (stopProvider == null) return null;
  let stop = null;
  let stopAt = '';
  let stopIndex = -1;
  let okAt = '';
  let okIndex = -1;
  for (let index = 0; index < (nodes ?? []).length; index++) {
    const node = nodes[index];
    if (!node || typeof node !== 'object') continue;
    if (stopProviderForNode(node) !== stopProvider) continue;
    const at = typeof node.recordedAt === 'string' ? node.recordedAt : '';
    if (node.providerStop && typeof node.providerStop === 'object') {
      if (at > stopAt || (at === stopAt && index > stopIndex)) {
        stop = node.providerStop;
        stopAt = at;
        stopIndex = index;
      }
    } else if (node.exitCode === 0 && node.blocked !== true) {
      if (at > okAt || (at === okAt && index > okIndex)) {
        okAt = at;
        okIndex = index;
      }
    }
  }
  if (!stop) return null;
  if (okIndex >= 0 && (okAt > stopAt || (okAt === stopAt && okIndex > stopIndex))) return null;
  return { providerStop: stop, recordedAt: stopAt || null };
}

/** A regular file's text, opened with O_NOFOLLOW: a link (even one swapped in after a listing)
 * is refused, never followed. Rejects when the file cannot be read. */
export async function readRegular(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`not a regular file: ${file}`);
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/** Every node in the tree's *.jsonl files. A link is never followed and a file that cannot be read
 * is counted (`unreadableFiles`), like a line that does not parse, instead of failing the read. */
export async function readNodes(treeDir) {
  const nodes = [];
  let unreadableLines = 0;
  let unreadableFiles = 0;
  let entries = [];
  try { entries = await readdir(treeDir, { withFileTypes: true }); } catch { return { nodes, unreadableLines, unreadableFiles }; }
  for (const name of entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name).sort()) {
    let text;
    try { text = await readRegular(path.join(treeDir, name)); } catch { unreadableFiles += 1; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { nodes.push(JSON.parse(line)); } catch { unreadableLines += 1; }
    }
  }
  return { nodes, unreadableLines, unreadableFiles };
}

/**
 * Newest usable reading for a provider, from recorded nodes only (max by recordedAt; equal
 * values prefer the later line, which preserves execution order within one file). Within a node
 * the end-of-run state (usageAfter) beats the start-of-run one. A non-ok reading is a missing
 * reading, never a zero one. `expired` is true once ANY scoped window's resetsAt is <= nowMs (a
 * reset weekly window next to a current 5h one is still a stale weekly number); `expiredResetsAt`
 * names the earliest such reset.
 * Exported because dispatch.mjs records the same reading as a non-chosen route's candidate gate.
 */
export function latestReading(nodes, provider, nowMs = Date.now()) {
  const limitIds = budgetRows()[provider]?.limitIds ?? ROUTE_LIMIT_IDS[provider] ?? null;
  let best = null;
  let bestAt = '';
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.role === 'lead-correction') continue;
    if (providerForNode(node) !== provider) continue;
    const report = [node.usageAfter, node.usageBefore].find(r => r?.status === 'ok') ?? null;
    if (!report) continue;
    const at = typeof node.recordedAt === 'string' ? node.recordedAt : '';
    if (best && at < bestAt) continue;
    bestAt = at;
    best = {
      report,
      window: bindingWindow(report.windows ?? [], limitIds),
      recordedAt: node.recordedAt ?? null,
      task: node.task ?? null,
    };
  }
  // A reading taken before its window reset says nothing about the window now open. Still returned
  // (it is what was recorded), flagged so no gate reads it as current. A missing or unparseable
  // resetsAt cannot be dated: not expired.
  if (best) {
    const windows = best.report.windows ?? [];
    const scoped = limitIds ? windows.filter(w => limitIds.includes(w.limitId)) : windows;
    let expiredMs = Infinity;
    for (const w of scoped) {
      const resetMs = Date.parse(w?.resetsAt ?? '');
      if (Number.isFinite(resetMs) && resetMs <= nowMs && resetMs < expiredMs) {
        expiredMs = resetMs;
        best.expiredResetsAt = w.resetsAt;
      }
    }
    best.expired = expiredMs !== Infinity;
    if (!best.expired) best.expiredResetsAt = null;
  }
  return best;
}

