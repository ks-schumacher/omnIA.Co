#!/usr/bin/env python3
"""dcm2niix WebAssembly (browser build) vs native dcm2niix: byte-level identity of NIfTI outputs.
Usage: wasm_vs_native.py <data_root> <report.json>"""
import glob, json, os, subprocess, sys, tempfile, filecmp
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data, report = sys.argv[1], sys.argv[2]
flags = ['-b', 'y', '-ba', 'n', '-z', 'n', '-f', '%p_%s']
res = []
for ds in sorted(glob.glob(os.path.join(data, 'dcm_qa*'))):
    ind = os.path.join(ds, 'In')
    if not os.path.isdir(ind): continue
    w = tempfile.mkdtemp(); n = tempfile.mkdtemp()
    subprocess.run(['node', os.path.join(ROOT, 'test/cli/dcm2niix-wasm.mjs'), ind, w, *flags], capture_output=True)
    subprocess.run(['dcm2niix', *flags, '-o', n, ind], capture_output=True)
    wn = sorted(f for f in os.listdir(w) if f.endswith('.nii')); nn = sorted(f for f in os.listdir(n) if f.endswith('.nii'))
    same_names = wn == nn
    identical = sum(filecmp.cmp(os.path.join(w, f), os.path.join(n, f), shallow=False) for f in nn if f in wn)
    jdiff = 0
    for f in sorted(x for x in os.listdir(n) if x.endswith('.json')):
        if not os.path.exists(os.path.join(w, f)): jdiff += 1; continue
        a = json.load(open(os.path.join(n, f))); b = json.load(open(os.path.join(w, f)))
        a.pop('ConversionSoftwareVersion', None); b.pop('ConversionSoftwareVersion', None)
        jdiff += a != b
    for side in ('bval', 'bvec'):
        for f in sorted(x for x in os.listdir(n) if x.endswith(side)):
            if not os.path.exists(os.path.join(w, f)) or not filecmp.cmp(os.path.join(w, f), os.path.join(n, f), shallow=False): jdiff += 1
    # content match regardless of name: when several outputs share a name stem (e.g. secondary captures with the same
    # series number), dcm2niix appends a, b, c in file-enumeration order, which differs between file systems
    import hashlib
    def digest(d, f):
        return hashlib.sha256(open(os.path.join(d, f), 'rb').read()).hexdigest()
    def pair_digest(d, f):
        j = os.path.join(d, f[:-4] + '.json')
        js = json.load(open(j)) if os.path.exists(j) else {}
        js.pop('ConversionSoftwareVersion', None)
        return digest(d, f) + hashlib.sha256(json.dumps(js, sort_keys=True).encode()).hexdigest()
    from collections import Counter
    cw = Counter(pair_digest(w, f) for f in wn); cn = Counter(pair_digest(n, f) for f in nn)
    by_content = sum((cw & cn).values())
    r = {'dataset': os.path.basename(ds), 'nifti_native': len(nn), 'nifti_wasm': len(wn), 'same_names': same_names, 'byte_identical': identical,
         'identical_nifti_and_sidecar_by_content': by_content, 'sidecar_or_gradient_differences': jdiff}
    print(r); res.append(r)
json.dump(res, open(report, 'w'), indent=1)
tot = sum(r['nifti_native'] for r in res); ident = sum(r['byte_identical'] for r in res)
print(f'TOTAL NIfTI {tot}, byte-identical {ident}, metadata differences {sum(r["sidecar_or_gradient_differences"] for r in res)}')
print(f'identical NIfTI + sidecar pairs regardless of name: {sum(r["identical_nifti_and_sidecar_by_content"] for r in res)} of {tot}')
