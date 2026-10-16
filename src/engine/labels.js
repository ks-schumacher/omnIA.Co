// Label-map helpers: detection of segmentation volumes and parsing of label name tables.
import { effectiveScaling } from './nifti.js';

export const DEFAULT_CATEGORY = ['85756007', 'SCT', 'Tissue'];
export const DEFAULT_TYPE = ['85756007', 'SCT', 'Tissue'];

const NAME_HINT = /(^|[^a-z])(seg|segm|segmentation|mask|label|labels|labelmap|roi|lesion|lesions|aseg|parc|atlas)([^a-z]|$)/i;

/** Unique integer labels of a volume (3D), or null if not an integer label map with <= maxLabels labels. */
export function uniqueLabels(vol, maxLabels = 255) {
  if (vol.dims.length > 3 && vol.dims.slice(3).some((d) => d > 1)) return null;
  const { slope, inter } = effectiveScaling(vol.header);
  const d = vol.data;
  if (!d) return null;
  const big = d instanceof BigInt64Array || d instanceof BigUint64Array;
  const seen = new Set();
  for (let i = 0; i < d.length; i++) {
    const v = (big ? Number(d[i]) : d[i]) * slope + inter;
    if (!Number.isInteger(v)) return null;
    if (!seen.has(v)) {
      seen.add(v);
      if (seen.size > maxLabels + 1) return null;
    }
  }
  return [...seen].sort((a, b) => a - b);
}

/** Decide whether a NIfTI is a label map. mode: 'auto' | 'image' | 'seg' */
export function isLabelMap(vol, name, mode) {
  if (mode === 'image') return { label: false };
  const labels = uniqueLabels(vol);
  if (!labels) return { label: false, reason: mode === 'seg' ? 'not an integer label map with <= 255 labels' : undefined };
  const nonzero = labels.filter((v) => v !== 0);
  if (!nonzero.length) return { label: false, reason: 'empty mask' };
  if (nonzero.some((v) => v < 0 || v > 65535)) return { label: false, reason: 'negative or out-of-range labels' };
  if (mode === 'seg') return { label: true, labels: nonzero };
  const intent = vol.header.intent_code === 1002; // NIFTI_INTENT_LABEL
  const hint = NAME_HINT.test(name);
  return { label: (intent || hint) && labels.length <= 256, labels: nonzero };
}

/**
 * Parse a label table. Supported:
 *  - ITK-SNAP label description: IDX R G B A VIS MSH "LABEL"
 *  - JSON: {"1":"name"} or [{"value":1,"name":"x"}] (optional category/type code triplets)
 *  - CSV/TSV: value,name
 *  - FreeSurfer LUT: value name R G B A
 * @returns {Map<number,{label:string,category?:string[],type?:string[]}>}
 */
export function parseLabelTable(text, fileName = '') {
  const map = new Map();
  const t = text.trim();
  if (fileName.toLowerCase().endsWith('.json') || t.startsWith('{') || t.startsWith('[')) {
    const j = JSON.parse(t);
    const arr = Array.isArray(j) ? j : Object.entries(j).map(([k, v]) => (typeof v === 'string' ? { value: Number(k), name: v } : { value: Number(k), ...v }));
    for (const e of arr) {
      const value = Number(e.value ?? e.label ?? e.id);
      const name = String(e.name ?? e.label_name ?? e.description ?? `Label ${value}`);
      if (!Number.isInteger(value)) continue;
      const entry = { label: name };
      if (Array.isArray(e.category) && e.category.length === 3) entry.category = e.category.map(String);
      if (Array.isArray(e.type) && e.type.length === 3) entry.type = e.type.map(String);
      map.set(value, entry);
    }
    return map;
  }
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const q = /^(\d+)\s+.*"([^"]*)"\s*$/.exec(s); // ITK-SNAP
    if (q) { map.set(Number(q[1]), { label: q[2] }); continue; }
    const c = /^(\d+)\s*[,;\t]\s*([^,;\t]+)/.exec(s); // CSV/TSV
    if (c) { map.set(Number(c[1]), { label: c[2].trim() }); continue; }
    const f = /^(\d+)\s+(\S+)/.exec(s); // FreeSurfer LUT
    if (f) map.set(Number(f[1]), { label: f[2] });
  }
  return map;
}

export function buildSegments(labels, table) {
  return labels.map((v) => {
    const e = table && table.get(v);
    return {
      value: v,
      label: (e && e.label ? e.label : `Label ${v}`).replace(/[\\\x00-\x1F]/g, ' ').slice(0, 64),
      category: (e && e.category) || DEFAULT_CATEGORY,
      type: (e && e.type) || DEFAULT_TYPE,
    };
  });
}
