#!/usr/bin/env python3
"""Synthetic edge-case validation of OMNIA NIfTI -> DICOM (and back).

Each case writes a NIfTI with known properties, converts it with OMNIA (Node engine, identical to the
browser worker) and checks:
  * expected outcome (lossless conversion, quantisation, or a refusal with a reason);
  * independent voxel check with pydicom + nibabel (dicom_vs_nifti.py);
  * round trip through native dcm2niix (voxel-exact in world space) when dcm2niix handles the geometry;
  * DICOM conformance with dciodvfy (no errors);
  * DWI: gradient directions recovered by dcm2niix; SEG: decoded with highdicom and compared voxel by voxel.
Usage: validate_synthetic.py <report.json>
"""
import gzip, json, os, shutil, subprocess, sys, tempfile, zipfile, glob
import numpy as np, nibabel as nib

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
W = tempfile.mkdtemp(prefix='omnia_syn_')
rng = np.random.default_rng(20261015)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def rot(ax, deg):
    t = np.radians(deg); c, s = np.cos(t), np.sin(t)
    if ax == 'x': return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])
    if ax == 'y': return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def affine(R=np.eye(3), zooms=(1, 1, 1), origin=(-90, -110, -70)):
    A = np.eye(4); A[:3, :3] = R @ np.diag(zooms); A[:3, 3] = origin; return A


def phantom(shape, dtype=np.int16, lo=-1024, hi=3071):
    """Asymmetric phantom: gradient + a marker block in the +x/+y/+z corner (left-right/AP/SI asymmetry)."""
    x, y, z = np.meshgrid(*[np.linspace(0, 1, n) for n in shape[:3]], indexing='ij')
    v = lo + (hi - lo) * (0.2 * x + 0.3 * y + 0.5 * z)
    v[int(shape[0] * .7):, int(shape[1] * .6):, int(shape[2] * .8):] = hi
    return np.round(v).astype(dtype)


def save(img, name, gz=False):
    p = os.path.join(W, name + ('.nii.gz' if gz else '.nii'))
    nib.save(img, p); return p


def mk(data, A, **hdr):
    img = nib.Nifti1Image(data, A)
    img.header.set_sform(A, code=hdr.pop('scode', 1)); img.header.set_qform(A, code=hdr.pop('qcode', 1))
    if 'slope' in hdr: img.header.set_slope_inter(hdr.pop('slope'), hdr.pop('inter'))
    return img


def omnia(nii, out, *extra):
    r = run(['node', os.path.join(ROOT, 'test/cli/nii2dcm.mjs'), nii, out, *extra])
    if r.returncode != 0:
        err = [l for l in r.stderr.splitlines() if 'Error' in l and ' at ' not in l]
        return None, (err[0] if err else r.stderr[-300:]).strip()
    return json.loads(r.stdout.strip().splitlines()[-1]), None


def independent(out, nii, quant=None, ulp=False):
    cmd = [sys.executable, os.path.join(ROOT, 'test/py/dicom_vs_nifti.py'), out, nii]
    if quant is not None: cmd += ['--quantized', repr(quant)]
    if ulp: cmd += ['--ulp']
    r = run(cmd)
    return json.loads(r.stdout.strip().splitlines()[-1])


def roundtrip(out, nii, ulp=False):
    b = tempfile.mkdtemp(dir=W)
    run(['dcm2niix', '-b', 'y', '-z', 'n', '-f', 'rt', '-o', b, out])
    niis = [x for x in glob.glob(os.path.join(b, '*.nii')) if '_Tilt' not in x and '_Eq' not in x and '_ADC' not in x]
    if len(niis) != 1: return {'ok': False, 'reason': f'dcm2niix outputs {os.listdir(b)}'}, b
    c = run([sys.executable, os.path.join(ROOT, 'test/py/compare_nifti.py'), nii, niis[0]] + (['--ulp'] if ulp else []))
    return json.loads(c.stdout.strip().splitlines()[-1]), b


def dciodvfy(out):
    errs = set()
    fs = sorted(glob.glob(os.path.join(out, '*.dcm')))
    for f in (fs[0], fs[-1]):
        v = run(['dciodvfy', f])
        errs |= {l for l in (v.stdout + v.stderr).splitlines() if l.startswith('Error')}
    return sorted(errs)


results = []


def case(name, nii, expect='lossless', extra=(), quant=False, rt=True, dwi=None, note=''):
    out = os.path.join(W, 'out_' + name)
    args = list(extra) + (['--quantize'] if quant else [])
    if dwi: args += ['--bval', dwi[0], '--bvec', dwi[1]]
    info, err = omnia(nii, out, *args)
    rec = {'case': name, 'note': note, 'expect': expect}
    if expect == 'refuse':
        rec['ok'] = info is None
        rec['reason'] = err
        results.append(rec); print(('PASS' if rec['ok'] else 'FAIL'), name, '-> refused:', err); return
    if info is None:
        rec['ok'] = False; rec['error'] = err; results.append(rec); print('FAIL', name, err); return
    rec['encoding'] = info['enc']; rec['self_check'] = info['verify']['ok']
    ind = independent(out, nii, info['verify']['maxAbsDiff'] if quant else None, ulp='ulp' in info['enc'])
    rec['independent'] = ind['ok']
    rec['dciodvfy_errors'] = dciodvfy(out)
    ok = rec['self_check'] and rec['independent'] and not rec['dciodvfy_errors']
    if expect == 'quantized':
        ok = ok and info['mode'] == 'quantized'; rec['max_abs_error'] = info['verify']['maxAbsDiff']
    elif expect == 'lossless':
        ok = ok and info['mode'] in ('direct', 'lattice')
    if rt:
        r, bdir = roundtrip(out, nii, ulp=nib.load(nii).get_data_dtype() == np.float32)
        rec['roundtrip'] = r.get('ok'); rec['roundtrip_affine_mm'] = r.get('max_affine_mm')
        if expect == 'quantized':
            # dcm2niix stores the rescale slope as float32 in the NIfTI: allow that rounding on top of the bound
            vmax = float(np.abs(nib.load(nii).get_fdata()).max())
            rec['roundtrip'] = r.get('max_affine_mm', 9) < 1e-3 and r.get('max_abs_value_diff', 9e9) <= info['verify']['maxAbsDiff'] + 2 * vmax * 2.0 ** -23 + 1e-12
        ok = ok and rec['roundtrip']
        if dwi:
            b0 = np.loadtxt(dwi[0]).ravel(); v0 = np.loadtxt(dwi[1]).reshape(3, -1)
            bf = glob.glob(os.path.join(bdir, '*.bval'))
            if bf:
                b1 = np.loadtxt(bf[0]).ravel(); v1 = np.loadtxt(bf[0][:-5] + '.bvec').reshape(3, -1)
                m = b0 > 0
                u0 = v0[:, m] / np.linalg.norm(v0[:, m], axis=0); u1 = v1[:, m] / np.linalg.norm(v1[:, m], axis=0)
                rec['bval_equal'] = bool(np.array_equal(b0, b1)); rec['bvec_max_dev'] = float(np.abs(u0 - u1).max())
                ok = ok and rec['bval_equal'] and rec['bvec_max_dev'] < 1e-4
            else:
                rec['bval_equal'] = False; ok = False
    rec['ok'] = bool(ok)
    results.append(rec)
    print(('PASS' if ok else 'FAIL'), name, {k: v for k, v in rec.items() if k not in ('case', 'note', 'expect')})


# ---------------------------------------------------------------------------------------------
sh = (64, 72, 40)
A_las = affine(np.diag([-1, 1, 1]), (0.8, 0.8, 2.5), (60, -100, -50))
case('ct_int16_las', save(mk(phantom(sh), A_las), 'ct_int16_las'), extra=['--modality', 'CT'], note='CT HU, dcm2niix-like LAS storage')
case('mr_uint8', save(mk(phantom(sh, np.uint8, 0, 255), affine()), 'mr_uint8'), note='uint8 stored as 16-bit')
case('int16_scaled', save(mk(phantom(sh, np.int16, -500, 2000), affine(), slope=0.5, inter=-100), 'int16_scaled'), note='scl_slope 0.5, scl_inter -100')
lat = (rng.integers(0, 60000, size=sh) * 1000).astype(np.int32)
case('int32_lattice', save(mk(lat, affine()), 'int32_lattice'), note='int32 values on a lattice of step 1000 (exact)')
wide = rng.integers(0, 200001, size=sh).astype(np.int32)
case('int32_wide_refuse', save(mk(wide, affine()), 'int32_wide'), expect='refuse', note='>65536 distinct levels: lossless impossible')
case('int32_wide_quant', os.path.join(W, 'int32_wide.nii'), expect='quantized', quant=True, note='explicit quantisation, bounded error')
adc = (rng.integers(0, 4000, size=sh) * np.float32(1e-6)).astype(np.float32)
case('float32_adc_lattice', save(mk(adc, affine()), 'adc'), note='float32 ADC = k x 1e-6 (exact lattice)')
prob = rng.random(sh, dtype=np.float32)
case('float32_prob_refuse', save(mk(prob, affine()), 'prob'), expect='refuse', note='arbitrary floats')
case('float32_prob_quant', os.path.join(W, 'prob.nii'), expect='quantized', quant=True, note='quantised probability map')
nanv = prob.copy(); nanv[0, 0, :5] = np.nan
case('float32_nan_refuse', save(mk(nanv, affine()), 'nan'), expect='refuse', note='NaN voxels')
case('float64_integer', save(mk(phantom(sh).astype(np.float64), affine()), 'f64int'), note='integer-valued float64')
A_obl = affine(rot('x', 20) @ rot('y', -15) @ rot('z', 8), (0.9, 0.9, 3.0), (-80, -95, -40))
case('oblique', save(mk(phantom(sh), A_obl), 'oblique'), note='double-oblique')
A_sag = np.array([[0, 0, -1.2, 80], [-0.9, 0, 0, 120], [0, -0.9, 0, 110], [0, 0, 0, 1.]])
case('sagittal_PIL', save(mk(phantom((96, 96, 30)), A_sag), 'sagittal'), note='sagittal acquisition stored P-I-L')
A_cor = np.array([[-0.8, 0, 0, 100], [0, 0, 3.0, -40], [0, 0.8, 0, -80], [0, 0, 0, 1.]])
case('coronal', save(mk(phantom((80, 80, 24)), A_cor), 'coronal'), note='coronal acquisition')
case('ras_positive_det', save(mk(phantom(sh), affine(np.eye(3), (1, 1, 1.5))), 'ras'), note='neurological (det>0) storage')
img = mk(phantom(sh), A_obl, scode=0)
case('qform_only', save(img, 'qform_only'), note='sform_code 0: qform used')
img = mk(phantom(sh), A_obl); img.header.set_sform(affine(np.eye(3), (1, 1, 1)), code=1)
case('sform_qform_conflict', save(img, 'conflict'), note='diverging qform/sform: sform used (warning)')
n2 = nib.Nifti2Image(phantom(sh), A_obl); n2.header.set_sform(A_obl, 1); n2.header.set_qform(A_obl, 1)
case('nifti2', save(n2, 'nifti2'), note='NIfTI-2 header')
be = mk(phantom(sh).astype('>i2'), A_obl); be.set_data_dtype('>i2')
p_be = save(be, 'bigendian')
with open(p_be, 'rb') as f: raw = f.read()
case('big_endian', p_be if raw[:4] == (348).to_bytes(4, 'big') else p_be, note='big-endian NIfTI-1')
p_gz = save(mk(phantom(sh), A_obl), 'multimember', gz=False)
data = open(p_gz, 'rb').read(); half = len(data) // 2
p_mm = os.path.join(W, 'multimember.nii.gz')
with open(p_mm, 'wb') as f: f.write(gzip.compress(data[:half]) + gzip.compress(data[half:]))
case('gzip_multimember', p_mm, note='concatenated gzip members')
A_shear = affine(); A_shear[0, 1] = 0.3
case('inplane_shear_refuse', save(mk(phantom(sh), A_shear), 'shear'), expect='refuse', note='in-plane shear cannot be represented')
A_tilt = affine(np.eye(3), (0.5, 0.5, 2.5)); A_tilt[1, 2] = 0.8
case('slice_shear_tilt', save(mk(phantom(sh), A_tilt), 'tilt'), extra=['--modality', 'CT'], rt=False, note='gantry-tilt-like sheared slice axis (dcm2niix approximates tilt, so no round trip)')
p_no = save(mk(phantom(sh), A_obl), 'noorient')
with open(p_no, 'r+b') as f:  # nibabel re-sets codes on save: zero them directly in the header
    f.seek(252); f.write((0).to_bytes(2, 'little')); f.seek(254); f.write((0).to_bytes(2, 'little'))
case('no_orientation_refuse', p_no, expect='refuse', note='qform_code = sform_code = 0')
rgb = np.zeros(sh[:2] + (4,), dtype=[('R', 'u1'), ('G', 'u1'), ('B', 'u1')])
case('rgb_refuse', save(nib.Nifti1Image(rgb, affine()), 'rgb'), expect='refuse', note='RGB data')
case('single_slice', save(mk(phantom((64, 64, 1)), affine()), 'single'), rt=False, note='2D image (nz = 1)')
# DWI with positive determinant and oblique geometry
nv = 12
d4 = np.stack([phantom(sh) + 10 * t for t in range(nv)], -1).astype(np.int16)
A_dwi = affine(rot('x', 12) @ rot('z', -9), (2, 2, 2.5))
pd = save(mk(d4, A_dwi), 'dwi_oblique_posdet')
bvals = np.array([0] + [1000] * (nv - 1))
dirs = rng.normal(size=(3, nv)); dirs /= np.linalg.norm(dirs, axis=0); dirs[:, 0] = 0
np.savetxt(os.path.join(W, 'dwi.bval'), bvals[None], fmt='%d'); np.savetxt(os.path.join(W, 'dwi.bvec'), dirs, fmt='%.8f')
case('dwi_oblique_posdet', pd, dwi=(os.path.join(W, 'dwi.bval'), os.path.join(W, 'dwi.bvec')), note='4D DWI, det>0, oblique')
A_dwi2 = affine(np.diag([-1, 1, 1]) @ rot('y', 10), (2, 2, 2.5))
pd2 = save(mk(d4, A_dwi2), 'dwi_negdet')
case('dwi_negdet', pd2, dwi=(os.path.join(W, 'dwi.bval'), os.path.join(W, 'dwi.bvec')), note='4D DWI, det<0 (FSL radiological)')

# ---------------------------------------------------------------------------------------------
# SEG: image + label map in one exam archive -> OMNIA exam pipeline (NIfTI->DICOM direction)
img_data = phantom(sh)
lab = np.zeros(sh, np.uint8); lab[10:30, 20:40, 5:20] = 1; lab[35:50, 30:60, 15:35] = 2; lab[5:9, 5:9, 2:4] = 7
zp = os.path.join(W, 'seg_exam.zip')
with zipfile.ZipFile(zp, 'w') as z:
    nib.save(mk(img_data, A_obl), os.path.join(W, 't1.nii.gz')); z.write(os.path.join(W, 't1.nii.gz'), 'case/t1.nii.gz')
    nib.save(mk(lab, A_obl), os.path.join(W, 'lesion_seg.nii.gz')); z.write(os.path.join(W, 'lesion_seg.nii.gz'), 'case/lesion_seg.nii.gz')
    z.writestr('case/lesion_seg.json', json.dumps({"1": "Lesion A", "2": "Lesion B", "7": "Small focus"}))
segout = os.path.join(W, 'seg_out')
r = run(['node', os.path.join(ROOT, 'test/cli/exam.mjs'), zp, segout, '--direction', 'nii2dcm'])
rec = {'case': 'seg_via_exam', 'note': 'image + label map -> CT/MR series + DICOM SEG referencing it'}
try:
    summ = json.loads(r.stdout)
    rec['exam_status'] = summ['status']; rec['series'] = [(s['input'].split('/')[-1], s['status'], s['verification']) for s in summ['series']]
    segf = glob.glob(os.path.join(segout, '**/SEG_*.dcm'), recursive=True)
    import highdicom as hd, pydicom
    seg = hd.seg.segread(segf[0])
    src_dir = [d for d in glob.glob(os.path.join(segout, '*/*')) if os.path.isdir(d) and 'SEG' not in d][0]
    srcs = [pydicom.dcmread(f) for f in sorted(glob.glob(os.path.join(src_dir, '*.dcm')))]
    vol = seg.get_volume(combine_segments=True, relabel=False) if hasattr(seg, 'get_volume') else None
    # compare per segment via source-image mapping
    ok = True
    sop_to_k = {}
    Minv = np.linalg.inv(A_obl)
    for d in srcs:
        ipp = np.array(d.ImagePositionPatient, float) * np.array([-1, -1, 1])
        k = int(round((Minv[:3, :3] @ ipp + Minv[:3, 3])[2])); sop_to_k[d.SOPInstanceUID] = (k, d)
    labels_by_num = {1: 1, 2: 2, 3: 7}
    for segnum, val in labels_by_num.items():
        rec_mask = np.zeros(sh, bool)
        arr = seg.get_pixels_by_source_instance(source_sop_instance_uids=list(sop_to_k.keys()), segment_numbers=[segnum], assert_missing_frames_are_empty=True)
        for (uid, plane) in zip(list(sop_to_k.keys()), arr[..., 0]):
            k, d = sop_to_k[uid]
            ipp = np.array(d.ImagePositionPatient, float); iop = np.array(d.ImageOrientationPatient, float); ps = np.array(d.PixelSpacing, float)
            rr, cc = np.mgrid[0:d.Rows, 0:d.Columns]
            lps = ipp + cc[..., None] * ps[1] * iop[:3] + rr[..., None] * ps[0] * iop[3:]
            idx = np.rint((Minv[:3, :3] @ (lps.reshape(-1, 3) * [-1, -1, 1]).T).T + Minv[:3, 3]).astype(int)
            rec_mask[idx[:, 0], idx[:, 1], idx[:, 2]] = plane.reshape(-1) > 0
        if not np.array_equal(rec_mask, lab == val): ok = False
    rec['highdicom_voxel_exact'] = ok
    rec['segment_labels'] = [s.SegmentLabel for s in seg.SegmentSequence]
    rec['dciodvfy_errors'] = sorted({l for l in (run(['dciodvfy', segf[0]]).stdout + run(['dciodvfy', segf[0]]).stderr).splitlines() if l.startswith('Error')})
    rec['ok'] = ok and summ['status'] in ('ok', 'warning') and all(s[1] == 'ok' for s in rec['series']) and not rec['dciodvfy_errors']
except Exception as e:  # noqa
    rec['ok'] = False; rec['error'] = repr(e)[:400]; rec['stdout'] = r.stdout[-400:]; rec['stderr'] = r.stderr[-400:]
results.append(rec)
print(('PASS' if rec['ok'] else 'FAIL'), 'seg_via_exam', {k: v for k, v in rec.items() if k not in ('case', 'note')})

json.dump(results, open(sys.argv[1], 'w'), indent=1)
print(f"\nSYNTHETIC: {sum(r['ok'] for r in results)}/{len(results)} passed")
shutil.rmtree(W, ignore_errors=True)
