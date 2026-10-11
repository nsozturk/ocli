// Recorded tree readings only: no provider calls or budget reporting.
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { BUDGET, ROUTE_LIMIT_IDS, bindingWindow } from './usage.mjs';

/** Which budget row a recorded node belongs to. `null` = not a developer dispatch we account for. */
export function providerForNode(node) {
  if (node?.role === 'lead-correction') return null; // the lead's annotation on a node, not a run
  if (node?.cli === 'codex') return 'codex';
  if (node?.cli === 'opencode' && String(node.model ?? '').startsWith('zai-coding-plan/')) return 'glm';
  if (node?.cli === 'claude' || node?.cli === 'claude-agent' || node?.cli === 'claude-code') return 'claude';
  if (node?.cli === 'agy') return 'gemini';
  if (node?.cli === 'cline') return 'cline'; // Cline Pass: no BUDGET row, no readable counter yet
  return null;
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
 * reading, never a zero one.
 * Exported because dispatch.mjs records the same reading as a non-chosen route's candidate gate.
 */
export function latestReading(nodes, provider) {
  const limitIds = BUDGET[provider]?.limitIds ?? ROUTE_LIMIT_IDS[provider] ?? null;
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
  return best;
}

