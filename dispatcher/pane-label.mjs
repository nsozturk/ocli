// paneLabel, shared by dispatch.mjs and digest.mjs. Pure: no I/O, no imports. Kept apart from
// dispatch.mjs so the digest (copied into plugin/lib/) needs nothing that spawns.

/** Untrusted text made safe for the pane: markdown heading marks, ANSI escapes and control
 * characters removed, whitespace folded, at most `max` code points. */
export function paneLabel(source, max) {
  const text = String(source ?? '')
    .replace(/[\u001b\u009d]\][^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, '') // OSC, e.g. hyperlinks
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '') // CSI
    // C0/C1, bidi controls (U+061C ALM among them) and the invisible U+200B/U+2060, as the pane's
    // clean() strips them; ZWNJ/ZWJ stay, scripts and emoji join with them and they reorder nothing.
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069]/g, '')
    .replace(/^\s*#+\s*/, '').replace(/\s+/g, ' ').trim();
  return [...text].slice(0, max).join(''); // code points, so a cut never splits a surrogate pair
}
