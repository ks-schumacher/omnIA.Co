// Archive expansion: ZIP (own reader) and RAR / 7z / TAR / tar.gz / tar.bz2 / tar.xz (libarchive WASM),
// recursive (nested archives), with classification of every entry.
import { readZip, sourceFromBlob, sourceFromBytes, ZipUnsupportedError } from './zip.js';
import { looksLikeDicom } from './dicom/read.js';

export const MAX_NESTING = 4;

let libarchiveAdapter = null;
/** Inject the libarchive adapter: async (blob, name, password) => [{path, size, getBytes}] */
export function setLibarchiveAdapter(fn) { libarchiveAdapter = fn; }

export function sniffArchive(head, name = '') {
  const b = head;
  const lower = name.toLowerCase();
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) return 'zip';
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1a && b[5] === 0x07) return 'rar';
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf && b[4] === 0x27 && b[5] === 0x1c) return '7z';
  if (b.length > 262 && b[257] === 0x75 && b[258] === 0x73 && b[259] === 0x74 && b[260] === 0x61 && b[261] === 0x72) return 'tar';
  if (b[0] === 0x1f && b[1] === 0x8b) {
    if (/\.nii\.gz$|\.img\.gz$|\.hdr\.gz$/.test(lower)) return null; // gzipped NIfTI, not an archive
    if (/\.(tgz|tar\.gz)$/.test(lower)) return 'tar.gz';
    return null;
  }
  if (b[0] === 0x42 && b[1] === 0x5a && b[2] === 0x68 && /\.(tbz2?|tar\.bz2)$/.test(lower)) return 'tar.bz2';
  if (b[0] === 0xfd && b[1] === 0x37 && b[2] === 0x7a && b[3] === 0x58 && b[4] === 0x5a && /\.(txz|tar\.xz)$/.test(lower)) return 'tar.xz';
  return null;
}

const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$|\._)/i;

/**
 * Expand an archive (or a single file) into a flat list of leaf entries.
 * @param {Blob|Uint8Array} input
 * @param {string} name
 * @param {{password?:string, onProgress?:(msg:string)=>void}} opts
 * @returns {Promise<{entries: {path:string,size:number,getBytes:()=>Promise<Uint8Array>}[], warnings:string[], containers:string[]}>}
 */
export async function expandArchive(input, name, opts = {}, depth = 0, prefix = '') {
  const warnings = [];
  const containers = [];
  const src = input instanceof Uint8Array ? sourceFromBytes(input) : sourceFromBlob(input);
  const head = await src.read(0, Math.min(src.size, 512));
  const kind = sniffArchive(head, name);
  if (!kind) {
    const getBytes = input instanceof Uint8Array ? async () => input : async () => new Uint8Array(await input.arrayBuffer());
    return { entries: [{ path: prefix + name, size: src.size, getBytes }], warnings, containers };
  }
  if (depth > MAX_NESTING) {
    warnings.push(`${prefix}${name}: nesting deeper than ${MAX_NESTING} levels ignored`);
    return { entries: [], warnings, containers };
  }
  containers.push(`${prefix}${name} (${kind})`);
  let raw = [];
  if (kind === 'zip') {
    try {
      raw = await readZip(src);
      if (raw.some((e) => e.encrypted || (e.method !== 0 && e.method !== 8 && !e.isDir))) throw new ZipUnsupportedError('needs libarchive');
    } catch (e) {
      if (!(e instanceof ZipUnsupportedError)) throw e;
      if (!libarchiveAdapter) throw new Error('This ZIP needs libarchive (encrypted or unusual compression)');
      raw = await libarchiveAdapter(input instanceof Uint8Array ? new Blob([input]) : input, name, opts.password);
    }
  } else {
    if (!libarchiveAdapter) throw new Error(`${kind} archives require libarchive`);
    raw = await libarchiveAdapter(input instanceof Uint8Array ? new Blob([input]) : input, name, opts.password);
  }
  const entries = [];
  for (const e of raw) {
    if (e.isDir || JUNK.test(e.path)) continue;
    const base = e.path.split('/').pop();
    const lower = base.toLowerCase();
    if (/\.(zip|rar|7z|tar|tgz|tar\.gz|tbz2?|tar\.bz2|txz|tar\.xz)$/.test(lower)) {
      try {
        const bytes = await e.getBytes();
        const sub = await expandArchive(bytes, base, opts, depth + 1, `${prefix}${name}/${e.path.slice(0, e.path.length - base.length)}`);
        entries.push(...sub.entries); warnings.push(...sub.warnings); containers.push(...sub.containers);
      } catch (err) {
        warnings.push(`${prefix}${name}/${e.path}: nested archive could not be opened (${err.message})`);
      }
      continue;
    }
    entries.push({ path: `${prefix}${name}/${e.path}`, size: e.size, getBytes: e.getBytes });
  }
  return { entries, warnings, containers };
}

/** Classify an entry from its name and first bytes. */
export function classifyEntry(path, head) {
  const base = path.split('/').pop();
  const lower = base.toLowerCase();
  if (lower === 'dicomdir') return 'dicomdir';
  if (/\.nii(\.gz)?$/.test(lower)) return 'nifti';
  if (/\.hdr(\.gz)?$/.test(lower)) return 'nifti-hdr';
  if (/\.img(\.gz)?$/.test(lower)) return 'nifti-img';
  if (/\.bval$/.test(lower) || lower === 'bvals') return 'bval';
  if (/\.bvec$/.test(lower) || lower === 'bvecs') return 'bvec';
  if (/\.json$/.test(lower)) return 'json';
  if (/\.(txt|csv|tsv|lut|ctbl)$/.test(lower)) return 'text';
  if (head && looksLikeDicom(head)) return 'dicom';
  if (/\.(dcm|dicom|ima)$/.test(lower)) return 'dicom?';
  return 'other';
}

/** libarchive.js adapter factory (browser: worker-based Archive; node: libarchive-node.mjs).
 * The whole archive is extracted in one sequential pass (single-entry extraction would re-scan
 * solid/streamed formats such as RAR for every file). Extracted files are kept as Blobs. */
export function makeLibarchiveAdapter(Archive) {
  return async (blob, name, password) => {
    const archive = await Archive.open(blob);
    if (password) await archive.usePassword(password);
    let encrypted = null;
    try { encrypted = await archive.hasEncryptedData(); } catch { /* unknown */ }
    if (encrypted && /\.rar$/i.test(name)) throw new Error('password-protected RAR archives are not supported (libarchive limitation); re-pack as ZIP');
    if (encrypted && !password) throw new Error('archive is password-protected: set the archive password before starting');
    let files = [];
    try {
      await archive.extractFiles();
      // after a full extraction the listing carries the extracted File objects
      files = (await archive.getFilesArray())
        .filter((e) => e && e.file && typeof e.file.arrayBuffer === 'function')
        .map((e) => ({ path: `${e.path || ''}${e.file.name}`, file: e.file }));
    } catch (err) {
      const msg = String((err && err.message) || err);
      if (/\.rar$/i.test(name) && /PPMd|encrypt|passphrase|password|Bad RAR/i.test(msg)) {
        throw new Error(`cannot extract this RAR (${msg}); password-protected or unusual RAR archives are not supported: re-pack as ZIP`);
      }
      throw err;
    } finally {
      try { if (archive.close) await archive.close(); } catch { /* ignore */ }
    }
    return files.map(({ path, file }) => ({
      path, size: file.size, isDir: false,
      async getBytes() { return new Uint8Array(await file.arrayBuffer()); },
    }));
  };
}
