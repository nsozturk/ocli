// The witness: a CLI's closing claims checked against its own event trace. Text is a hint; the
// trace is the evidence: a CLI can say "Done and committed" while nothing was committed.
//
// Pure: no I/O. Everything it needs from the outside (the verifier's result, the tree, whether a sha
// is a commit) is handed in by dispatch.mjs. It reports findings and never decides anything: score,
// status and exit code are not its business.

// The normalized tool names (events.mjs): codex file_change, agy write_to_file, muse write_file,
// opencode edit/write; the rest are names other CLIs use for the same act.
export const EDIT_TOOLS = new Set(['file_change', 'write_to_file', 'write_file', 'edit', 'write', 'apply_patch', 'multiedit', 'patch']);
// codex command_execution, opencode/muse bash, agy run_command.
export const SHELL_TOOLS = new Set(['command_execution', 'bash', 'run_command']);
// Matched against each command of a shell line, launchers stripped: a test tool in first position.
// Anywhere in the raw detail, `cat package.json`, `rg vitest` and muse's recorded output all read as test runs.
export const TEST_PATTERN = /^(?:\S*\/)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|(?:(?:pnpm|yarn|bun)\s+)?(?:vitest|jest|pytest|tsc)\b|node\s+--test\b|claude\s+plugin\s+test\b|cargo\s+test\b|go\s+test\b)/i;
const SEGMENT = /&&|\|\||[;|\n]/;
// What runs in front of the real command: quotes, a shell's -c, env assignments, npx and kin.
// ponytail: a launcher not listed here hides its test run; policy.json testCommandPattern is the escape.
const LAUNCHER = /^(?:[\s('"`]+|(?:\S*\/)?(?:ba|z|da)?sh\s+-\w*c\s+|\w+=\S*\s+|(?:env|time|nice|exec|command|npx|bunx|uv\s+run|poetry\s+run|(?:pnpm|yarn|npm)\s+(?:exec|dlx)|python3?\s+-m|timeout\s+\S+|--)\s+)+/i;

/** The command a shell tool ran. codex's detail is the command; agy's, muse's and opencode's are JSON
 * whose other fields (muse's output, opencode's description) are not commands. A detail cut at 500
 * characters is no longer JSON, so the field is read out of it. */
function commandOf(detail) {
  const raw = String(detail ?? '');
  // muse's is pretty-printed: `{\n  "chunk_id": …`.
  if (!/^\s*\{\s*"/.test(raw)) return raw;
  const field = value => [].concat(value?.command ?? value?.CommandLine ?? value?.cmd ?? []).join(' ');
  try { return field(JSON.parse(raw)); } catch {
    const cut = raw.match(/"(?:command|CommandLine|cmd)"\s*:\s*("(?:[^"\\]|\\.)*")/);
    try { return cut ? JSON.parse(cut[1]) : ''; } catch { return ''; }
  }
}
const ranTest = (detail, pattern) => commandOf(detail).split(SEGMENT).some(segment => {
  const command = segment.replace(LAUNCHER, '');
  return pattern.test(command) && !/\s--(?:version|help)\b/.test(command);
});

const CLAIMS = {
  testsPass: /\ball\s+(?:the\s+)?(?:\d+\s+)?tests?\s+(?:now\s+)?pass(?:es|ed|ing)?\b|\btests?\s+(?:(?:are|is|all|now)\s+)*(?:green|passing|pass(?:es|ed)?)\b|\b\d+\s+passed\b/i,
  typecheckClean: /\b(?:type[\s-]?check(?:s|ing)?|tsc)\b[^.\n]{0,40}?\b(?:clean|pass(?:es|ed)?|green|ok|succeed(?:s|ed)?)\b|\bno\s+type\s+errors\b/i,
  redBeforeGreen: /\bred(?:\s|[,/-]|→|>|before|then|to)+green\b|\btests?\s+failed\s+(?:first|before)\b/i,
  done: /\b(?:done|fixed|complete|implemented)\b/i,
  // Not reported: a done that says work was made, which an unchanged tree contradicts.
  changed: /\b(?:fixed|implemented|committed)\b/i,
};
// A claim is read per clause, and a clause that negates ("not all tests pass", "could not complete")
// or counts failures ("3 failed | 12 passed") claims nothing: an honest failure report is not a claim.
const CLAUSE = /[.!?;\n]|\b(?:but|however|although|though)\b/i;
const NEGATED = /\b(?:not|never|cannot|unable|nothing|none)\b|n't\b|\bno\s+longer\b/i;
const FAILED_COUNT = /\b[1-9]\d*\s+(?:tests?\s+)?(?:failed|failures?)\b/i;
// A sha needs a digit: "commit defaced" is a word, not a commit (all-letter 7-char shas: ~0.1%).
const COMMITTED = /\bcommit(?:ted)?\b[\s:`'"(#]*(?:(?:as|at|in)\s+[`'"(#]*)?((?=[0-9a-f]*\d)[0-9a-f]{7,40})\b/gi;

/** What the final text claims; `commits` are the claimed shas, lowercased, first-seen order. */
export function claimsOf(finalText) {
  const clauses = (typeof finalText === 'string' ? finalText : '').split(CLAUSE).filter(clause => clause && !NEGATED.test(clause));
  const said = Object.fromEntries(Object.entries(CLAIMS).map(([name, pattern]) => [name,
    clauses.some(clause => pattern.test(clause) && !(name === 'testsPass' && FAILED_COUNT.test(clause)))]));
  said.commits = [...new Set(clauses.flatMap(clause => [...clause.matchAll(COMMITTED)]).map(match => match[1].toLowerCase()))];
  said.committed = said.commits.length > 0;
  return said;
}

const okOf = event => (typeof event.ok === 'boolean' ? event.ok : null); // null: unknown, never a pass or a fail

/**
 * `events` are the run's normalized records (seq from dispatch's emit, else their index); `verify` the
 * node's verify ({code}) or null; `changedFiles` a count or null (unknown); `commitExists(sha)` true,
 * false, or anything else for unknown; `testCommandPattern` policy.json's override, compiled with 'i'.
 */
export function witness(events, finalText, { verify = null, changedFiles = null, commitExists = null, testCommandPattern = null } = {}) {
  const testPattern = testCommandPattern ? new RegExp(testCommandPattern, 'i') : TEST_PATTERN;
  const said = claimsOf(finalText);
  const claims = ['testsPass', 'typecheckClean', 'redBeforeGreen', 'committed', 'done']
    .filter(name => said[name]);
  const findings = [];
  const add = (code, text) => findings.push({ code, text: text.slice(0, 200) });

  let firstEdit = Infinity;
  let lastEdit = -Infinity;
  const tests = [];
  (Array.isArray(events) ? events : []).forEach((event, index) => {
    if (event?.kind !== 'tool.end') return;
    const seq = Number.isInteger(event.seq) ? event.seq : index;
    // A failed edit changed nothing; an unknown one (agy) may have.
    if (EDIT_TOOLS.has(event.tool) && okOf(event) !== false) {
      firstEdit = Math.min(firstEdit, seq);
      lastEdit = Math.max(lastEdit, seq);
    } else if (SHELL_TOOLS.has(event.tool) && ranTest(event.detail, testPattern)) {
      tests.push({ seq, ok: okOf(event) });
    }
  });
  const lastGreen = Math.max(-Infinity, ...tests.filter(t => t.ok === true).map(t => t.seq));

  // A verifier killed before it exited (code null) gave no verdict.
  const verified = typeof verify?.code === 'number';
  if (said.testsPass && tests.length === 0 && !verified) {
    add('claimedTestsButNone', 'claims the tests pass, but no shell command in the trace ran a test and no verifier gave a verdict');
  }
  // An unknown test run after the last edit may have been green: stale is then unproven.
  if ((said.testsPass || said.typecheckClean) && lastGreen > -Infinity && lastGreen < lastEdit
    && !tests.some(t => t.seq > lastEdit && t.ok === null)) {
    add('staleGreen', `the last green test run (seq ${lastGreen}) came before the last edit (seq ${lastEdit})`);
  }
  const beforeEdit = tests.filter(t => t.seq < firstEdit);
  if (said.redBeforeGreen && !beforeEdit.some(t => t.ok === false) && !beforeEdit.some(t => t.ok === null)) {
    add('claimedRedNoFailingRun', 'claims red before green, but no test run failed before the first edit');
  }
  const missing = typeof commitExists === 'function' ? said.commits.filter(sha => commitExists(sha) === false) : [];
  if (missing.length) add('commitNotFound', `claimed commit ${missing.join(', ')} is not a commit made during this run`);
  // A bare "DONE" closes a review as well as an implementation: only a claim of work, or an edit tool
  // in the trace, says the tree should have moved. A commit made during the run is in changedFiles
  // (dispatch counts a moved HEAD), so a claimed sha never stands in for it.
  // ponytail: an implementer that says only "DONE", edits through the shell and changed nothing is
  // silent here; with --verify its null score says it.
  if (said.done && changedFiles === 0 && (said.changed || lastEdit > -Infinity)) add('doneNoChange', 'claims done, but the tree has no change');
  if (said.testsPass && verified && verify.code !== 0) {
    add('verifyContradicts', `claims the tests pass, but the verifier exited ${verify.code}`);
  }
  return { v: 1, claims, findings };
}
