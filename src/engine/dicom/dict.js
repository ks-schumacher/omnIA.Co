// DICOM data dictionary lookup (PS3.6), built from the generated dictionary text.
import { DICT_TEXT, REPEATERS_TEXT } from './dictionary.js';

const byTag = new Map(); // tag(number) -> { vr, keyword }
const byKeyword = new Map(); // keyword -> tag(number)
const repeaters = []; // { mask, value, vr, keyword }

for (const line of DICT_TEXT.split('\n')) {
  if (!line) continue;
  const [hex, vr, keyword] = line.split(' ');
  const tag = parseInt(hex, 16) >>> 0;
  byTag.set(tag, { vr, keyword });
  if (keyword && keyword !== '-') byKeyword.set(keyword, tag);
}
for (const line of REPEATERS_TEXT.split('\n')) {
  if (!line) continue;
  const [pattern, vr, keyword] = line.split(' ');
  // 'x' marks a repeating hex digit: build mask/value pair
  let mask = 0, value = 0;
  for (let i = 0; i < 8; i++) {
    const ch = pattern[i];
    mask = (mask << 4) >>> 0; value = (value << 4) >>> 0;
    if (ch !== 'X') { mask |= 0xF; value |= parseInt(ch, 16); }
  }
  repeaters.push({ mask: mask >>> 0, value: value >>> 0, vr, keyword });
}

/** Dictionary entry for a tag, or undefined (private/unknown). */
export function lookup(tag) {
  const e = byTag.get(tag >>> 0);
  if (e) return e;
  for (const r of repeaters) if (((tag & r.mask) >>> 0) === r.value) return r;
  return undefined;
}

/** VR string for a tag ('UN' when unknown). Ambiguous VRs come back as e.g. 'US|SS'. */
export function vrOf(tag) {
  if ((tag & 0xFFFF) === 0x0000) return 'UL'; // group length
  if (((tag >>> 16) & 1) === 1) {
    const elem = tag & 0xFFFF;
    if (elem >= 0x0010 && elem <= 0x00FF) return 'LO'; // private creator
    return 'UN';
  }
  const e = lookup(tag);
  return e ? e.vr : 'UN';
}

export function keywordOf(tag) {
  const e = lookup(tag);
  return e && e.keyword !== '-' ? e.keyword : undefined;
}

export function tagOf(keyword) {
  const t = byKeyword.get(keyword);
  if (t === undefined) throw new Error(`Unknown DICOM keyword: ${keyword}`);
  return t;
}

export function tagHex(tag) {
  const h = (tag >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `(${h.slice(0, 4)},${h.slice(4)})`;
}

export function isPrivate(tag) {
  return ((tag >>> 16) & 1) === 1;
}
