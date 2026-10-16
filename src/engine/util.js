// Small shared helpers.

export async function gzipAsync(u8, level = 6) {
  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('gzip');
    const out = new Response(new Blob([u8]).stream().pipeThrough(cs));
    return new Uint8Array(await out.arrayBuffer());
  }
  const { gzipSync } = await import('fflate');
  return gzipSync(u8, { level });
}

/** Filesystem-safe name fragment (ASCII, no separators). */
export function safeName(s, max = 48) {
  const t = String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '');
  return (t || 'x').slice(0, max);
}

/** BIDS label: alphanumeric only. */
export function bidsLabel(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '') || 'x';
}

export function stemOf(path) {
  return path.replace(/\.nii\.gz$|\.nii$|\.hdr\.gz$|\.hdr$|\.img\.gz$|\.img$|\.json$|\.bval$|\.bvec$|\.txt$|\.csv$|\.tsv$/i, '');
}

export function baseName(path) { return path.split('/').pop(); }

export const textDecoder = new TextDecoder('utf-8');

export function fmtNum(x, p = 4) {
  if (x === undefined || x === null || !Number.isFinite(x)) return String(x);
  return Number(x.toPrecision(p)).toString();
}
