#!/usr/bin/env python3
"""Validation of OMNIA NIfTI->DICOM on real-world reference NIfTIs (dcm_qa datasets).

For each reference NIfTI (+ BIDS sidecar, bval/bvec when present):
  1. OMNIA converts it to DICOM (Node, same engine as the browser) and self-verifies voxel by voxel.
  2. The DICOM output is converted back with native dcm2niix (independent implementation).
  3. compare_nifti.py checks voxel-exact equality in world space and affine agreement.
  4. DWI: b-values must match exactly; b-vectors within 1e-4 (sign-aware).
  5. dciodvfy (dicom3tools) checks IOD conformance of the first and last instance.
Writes a JSON report.
"""
import glob, json, os, subprocess, sys, tempfile, shutil
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = sys.argv[1]
OUT = sys.argv[2]
work = tempfile.mkdtemp(prefix='omnia_val_')

def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)

def read_bvec(p):
    return np.loadtxt(p).reshape(3, -1)

results = []
files = sorted(glob.glob(os.path.join(DATA, '*/Ref/*.nii')))
for idx, nii in enumerate(files):
    stem = nii[:-4]
    rec = {'file': os.path.relpath(nii, DATA)}
    js = stem + '.json'
    modality = 'MR'
    if os.path.exists(js):
        try:
            modality = json.load(open(js)).get('Modality', 'MR')
        except Exception:
            pass
    out = os.path.join(work, f'o{idx}')
    cmd = ['node', os.path.join(ROOT, 'test/cli/nii2dcm.mjs'), nii, out, '--modality', modality]
    if os.path.exists(js): cmd += ['--json', js]
    if os.path.exists(stem + '.bval') and os.path.exists(stem + '.bvec'):
        cmd += ['--bval', stem + '.bval', '--bvec', stem + '.bvec']
        rec['dwi'] = True
    r = run(cmd)
    if r.returncode != 0:
        err = [l for l in r.stderr.splitlines() if 'Error' in l and 'at ' not in l]
        rec['omnia'] = 'refused' if any('not supported' in l for l in err) else 'error'
        rec['error'] = (err or r.stderr.strip().splitlines() or ['?'])[0][:300]
        results.append(rec); print(rec['file'], rec['omnia'].upper(), rec['error']); continue
    info = json.loads(r.stdout.strip().splitlines()[-1])
    rec['omnia'] = 'ok'; rec['self_verify'] = info['verify']['ok']; rec['files'] = info['files']; rec['plane'] = info['plane']; rec['tilted'] = info['tilted']
    rec['encoding'] = info['enc']
    # V2: independent pydicom + nibabel voxel check (no OMNIA code, no dcm2niix)
    v2 = run([sys.executable, os.path.join(ROOT, 'test/py/dicom_vs_nifti.py'), out, nii])
    try:
        v2j = json.loads(v2.stdout.strip().splitlines()[-1]); rec['independent_check'] = v2j['ok']; rec['independent_max_index_err'] = v2j['max_index_error']
    except Exception:
        rec['independent_check'] = False; rec['independent_error'] = v2.stderr[-300:]
    # V2: independent pydicom + nibabel voxel check (no OMNIA code, no dcm2niix)
    v2 = run([sys.executable, os.path.join(ROOT, 'test/py/dicom_vs_nifti.py'), out, nii])
    try:
        v2j = json.loads(v2.stdout.strip().splitlines()[-1]); rec['independent_check'] = v2j['ok']; rec['independent_max_index_err'] = v2j['max_index_error']
        if not v2j['ok']: rec['independent_issues'] = v2j['issues']
    except Exception:
        rec['independent_check'] = False; rec['independent_error'] = v2.stderr[-300:]
    back = os.path.join(work, f'b{idx}'); os.makedirs(back)
    r2 = run(['dcm2niix', '-b', 'y', '-z', 'n', '-f', 'rt', '-o', back, out])
    niis = sorted(glob.glob(os.path.join(back, '*.nii')))
    rec['dcm2niix_outputs'] = [os.path.basename(x) for x in niis]
    main = [x for x in niis if '_Tilt' not in x and '_Eq' not in x and '_ADC' not in x]
    adc = [x for x in niis if x.endswith('_ADC.nii')]
    if len(main) != 1:
        rec['roundtrip'] = 'unexpected dcm2niix outputs'; results.append(rec); print(rec['file'], rec['roundtrip'], rec['dcm2niix_outputs']); continue
    src_for_cmp = nii
    if adc and rec.get('dwi'):
        # dcm2niix separates isotropic (b>0, zero-vector) volumes into *_ADC: compare the remaining volumes
        import nibabel as nib
        bv = np.loadtxt(stem + '.bval').ravel(); vv = read_bvec(stem + '.bvec')
        iso = (bv > 0) & (np.linalg.norm(vv, axis=0) < 1e-6)
        im = nib.load(nii); arr = np.asanyarray(im.dataobj)
        sub = nib.Nifti1Image(arr[..., ~iso], im.affine, im.header)
        src_for_cmp = os.path.join(back, 'src_noniso.nii'); nib.save(sub, src_for_cmp)
        rec['isotropic_volumes_split_by_dcm2niix'] = int(iso.sum())
    c = run([sys.executable, os.path.join(ROOT, 'test/py/compare_nifti.py'), src_for_cmp, main[0]])
    cmp = json.loads(c.stdout.strip().splitlines()[-1])
    rec['roundtrip'] = 'ok' if cmp['ok'] else ('n/a-tilt' if rec.get('tilted') else 'FAIL')
    rec['max_affine_mm'] = cmp.get('max_affine_mm'); rec['max_value_diff'] = cmp.get('max_abs_value_diff')
    if rec.get('dwi'):
        b0 = np.loadtxt(stem + '.bval').ravel(); b1p = main[0][:-4] + '.bval'
        v0 = read_bvec(stem + '.bvec')
        keep = ~((b0 > 0) & (np.linalg.norm(v0, axis=0) < 1e-6)) if adc else np.ones(b0.size, bool)
        if b0.size == 1:
            rec['bval_equal'] = 'n/a-single-volume'; rec['bvec_max_angle_deg'] = None
        elif os.path.exists(b1p):
            b1 = np.loadtxt(b1p).ravel(); v1 = read_bvec(main[0][:-4] + '.bvec')
            b0k, v0k = b0[keep], v0[:, keep]
            rec['bval_equal'] = bool(np.array_equal(b0k, b1))
            # compare directions (unit vectors) for diffusion-weighted volumes; b=0 directions are undefined
            dw = (b0k > 0) & (np.linalg.norm(v0k, axis=0) > 1e-6)
            u0 = v0k[:, dw] / np.linalg.norm(v0k[:, dw], axis=0); u1 = v1[:, dw] / np.linalg.norm(v1[:, dw], axis=0)
            cosang = np.clip(np.abs((u0 * u1).sum(0)), 0, 1)
            rec['bvec_max_angle_deg'] = float(np.degrees(np.arccos(cosang)).max()) if dw.any() else 0.0
            rec['bvec_same_sign'] = bool(((u0 * u1).sum(0) > 0).all()) if dw.any() else True
            rec['bvec_source_norm_range'] = [float(np.linalg.norm(v0k[:, dw], axis=0).min()), float(np.linalg.norm(v0k[:, dw], axis=0).max())] if dw.any() else None
        else:
            rec['bval_equal'] = False; rec['bvec_max_angle_deg'] = None
    dcms = sorted(glob.glob(os.path.join(out, '*.dcm')))
    errs = []
    for f in (dcms[0], dcms[-1]):
        v = run(['dciodvfy', f])
        errs += [l for l in (v.stdout + v.stderr).splitlines() if l.startswith('Error')]
    rec['dciodvfy_errors'] = sorted(set(errs))
    results.append(rec)
    print(f"{rec['file']}: self={rec['self_verify']} indep={rec.get('independent_check')} rt={rec['roundtrip']} aff={rec['max_affine_mm']:.2e} dv={rec['max_value_diff']} "
          + (f"bval={rec.get('bval_equal')} bvec_angle={rec.get('bvec_max_angle_deg')} sign={rec.get('bvec_same_sign')} " if rec.get('dwi') else '') + f"dciodvfy_errors={len(rec['dciodvfy_errors'])}")
    shutil.rmtree(out, ignore_errors=True); shutil.rmtree(back, ignore_errors=True)

json.dump(results, open(OUT, 'w'), indent=1)
conv = [r for r in results if r.get('omnia') == 'ok']
print(f"\nTOTAL {len(results)} | converted {len(conv)} | refused {sum(r.get('omnia')=='refused' for r in results)} | errors {sum(r.get('omnia')=='error' for r in results)}")
print(f"self-check OK {sum(bool(r.get('self_verify')) for r in conv)} | independent pydicom check OK {sum(bool(r.get('independent_check')) for r in conv)}")
print(f"dcm2niix round trip: ok {sum(r.get('roundtrip')=='ok' for r in conv)} | n/a-tilt {sum(r.get('roundtrip')=='n/a-tilt' for r in conv)} | FAIL {sum(r.get('roundtrip') not in ('ok','n/a-tilt') for r in conv)}")
print(f"dciodvfy errors (files with any): {sum(bool(r.get('dciodvfy_errors')) for r in conv)}")
