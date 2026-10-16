#!/usr/bin/env python3
"""Independent validation of the files produced by the browser end-to-end test (test/e2e/e2e.mjs).

Nothing here uses OMNIA code. Tools: native dcm2niix, pydicom, nibabel, numpy, scipy, highdicom, dciodvfy.

DICOM -> NIfTI (run A)
  * the source DICOM folders are converted again with the native dcm2niix; every NIfTI written by OMNIA in
    the browser must have a native counterpart with identical voxel array, scaling and affine (1e-4 mm),
    and identical .bval/.bvec when present;
  * de-identification: identifying strings and UIDs collected from every source DICOM header must not occur
    in any output file (sidecars, NIfTI headers and extensions, file names).
NIfTI -> DICOM (run B)
  * every DICOM image is mapped back to the source NIfTI voxel grid with pydicom + nibabel (dicom_vs_nifti.py);
  * the DICOM SEG is decoded with highdicom and compared voxel by voxel with the source label map;
  * the defaced head CT: every changed voxel must have become air (-1000 HU), and no changed voxel may
    touch an intracranial mask computed here independently (soft-tissue component enclosed by bone);
  * native dcm2niix converts the DICOM back and the result is compared with the source in world space;
  * dciodvfy (dicom3tools) on the first and last instance of every series and on the SEG.

usage: validate_e2e.py <data_root> <e2e_inputs> <e2e_outputs> <work_dir> <report.json>
"""
import glob, gzip, json, os, re, shutil, subprocess, sys, zipfile
import numpy as np, nibabel as nib, pydicom
from scipy import ndimage

data_root, e2e_in, e2e_out, work, report_path = sys.argv[1:6]
HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(work, exist_ok=True)
R = {'dicom_to_nifti': [], 'nifti_to_dicom': [], 'deidentification': {}}

# sidecar keys that hold scanner/protocol identifiers, not person or site identifiers
TECHNICAL_KEYS = {'SequenceName', 'PulseSequenceName', 'PulseSequenceDetails', 'SequenceVariant', 'ScanningSequence',
                  'ManufacturersModelName', 'SoftwareVersions', 'ImageType', 'ScanOptions',
                  # fixed texts written by OMNIA itself (e.g. 'DICOM PS3.15 Basic Profile')
                  'OMNIAVersion', 'OMNIAVerification', 'OMNIADeidentification',
                  # anatomical term (e.g. a phantom named 'HEAD')
                  'BodyPart', 'BodyPartExamined'}

SOURCES = {  # e2e archive -> public dcm_qa folder it was built from (make_e2e_inputs.py)
    'philips_exam.zip': 'dcm_qa_philips/In',
    'ge_exam.rar': 'dcm_qa_ge/In',
    'nested_exam.zip': 'dcm_qa_enh/In',
}


def word(v):
    """Case-insensitive whole-token match (a name such as 'Test' must not match 'LATEST')."""
    return re.compile(rb'(?<![A-Za-z0-9])' + re.escape(v.encode('utf-8', 'ignore')) + rb'(?![A-Za-z0-9])', re.I)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def unzip(z, dst):
    shutil.rmtree(dst, ignore_errors=True)
    with zipfile.ZipFile(z) as f:
        f.extractall(dst)
    return dst


def nifti_key(img):
    arr = np.asanyarray(img.dataobj.get_unscaled() if hasattr(img.dataobj, 'get_unscaled') else img.dataobj)
    return arr


# ---------------------------------------------------------------- run A: DICOM -> NIfTI
a_dir = os.path.join(e2e_out, 'A_dicom_to_nifti')
a_report = json.load(open(glob.glob(os.path.join(a_dir, '*.json'))[0]))
phi_hits = []
for ex in a_report['exams']:
    name = ex['name']
    rec = {'exam': name, 'status_in_browser': ex['status']}
    src = os.path.join(data_root, SOURCES[name])
    out = unzip(os.path.join(a_dir, ex['result']['zipName']), os.path.join(work, 'A', name))
    nat = os.path.join(work, 'A_native', name)
    shutil.rmtree(nat, ignore_errors=True); os.makedirs(nat)
    r = run(['dcm2niix', '-b', 'y', '-ba', 'n', '-z', 'n', '-i', 'n', '-w', '2', '-m', '2', '-f', '%s_%p_%t', '-o', nat, src])
    natives = []
    for f in sorted(glob.glob(os.path.join(nat, '*.nii'))):
        im = nib.load(f)
        natives.append((f, im, nifti_key(im)))
    omnia = sorted(glob.glob(os.path.join(out, '**', '*.nii.gz'), recursive=True))
    rows = []
    for f in omnia:
        im = nib.load(f)
        arr = nifti_key(im)
        match = None
        for nf, nim, narr in natives:
            if narr.shape == arr.shape and narr.dtype == arr.dtype and np.array_equal(narr, arr):
                match = (nf, nim); break
        row = {'omnia': os.path.relpath(f, out), 'shape': list(arr.shape)}
        if not match:
            row['ok'] = False; row['problem'] = 'no native dcm2niix output with an identical voxel array'
        else:
            nf, nim = match
            row['native'] = os.path.basename(nf)
            slope_eq = (float(im.dataobj.slope), float(im.dataobj.inter)) == (float(nim.dataobj.slope), float(nim.dataobj.inter))
            daff = float(np.abs(im.affine - nim.affine).max())
            row.update({'scaling_equal': slope_eq, 'affine_max_diff_mm': daff})
            ok = slope_eq and daff <= 1e-4
            for ext in ('bval', 'bvec'):
                a, b = f[:-7] + '.' + ext, nf[:-4] + '.' + ext
                if os.path.exists(a) or os.path.exists(b):
                    eq = os.path.exists(a) and os.path.exists(b) and np.allclose(np.loadtxt(a), np.loadtxt(b), atol=1e-6)
                    row[f'{ext}_equal'] = bool(eq); ok = ok and eq
            row['ok'] = bool(ok)
        rows.append(row)
    rec['outputs'] = rows
    rec['all_identical_to_native'] = all(x['ok'] for x in rows)
    rec['n_outputs'] = len(rows)
    # identifying strings from every source header
    tokens = {}
    fields = ['PatientName', 'PatientID', 'OtherPatientIDs', 'PatientBirthDate', 'InstitutionName', 'InstitutionAddress',
              'ReferringPhysicianName', 'PerformingPhysicianName', 'OperatorsName', 'AccessionNumber', 'StationName',
              'DeviceSerialNumber', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'FrameOfReferenceUID',
              'StudyDate', 'SeriesDate', 'AcquisitionDate', 'ContentDate', 'StudyID']
    for f in glob.glob(os.path.join(src, '**', '*'), recursive=True):
        if not os.path.isfile(f):
            continue
        try:
            ds = pydicom.dcmread(f, stop_before_pixels=True, force=True)
        except Exception:
            continue
        for k in fields:
            v = ds.get(k)
            if v in (None, ''):
                continue
            for part in re.split(r'[\^\\=]', str(v)):
                part = part.strip()
                if len(part) >= 4 and not part.isdigit() or (part.isdigit() and len(part) >= 8):
                    tokens.setdefault(part, k)
    texts = []
    for f in glob.glob(os.path.join(out, '**', '*'), recursive=True):
        if not os.path.isfile(f):
            continue
        texts.append((os.path.relpath(f, out), os.path.relpath(f, out).encode()))
        if f.endswith('.nii.gz'):
            raw = gzip.open(f).read(); vox = int(nib.load(f).header['vox_offset'])
            texts.append((os.path.relpath(f, out), raw[:max(vox, 352)]))
        elif f.endswith(('.json', '.bval', '.bvec', '.tsv', '.txt')):
            texts.append((os.path.relpath(f, out), open(f, 'rb').read()))
    jsons = {}
    for f in glob.glob(os.path.join(out, '**', '*.json'), recursive=True):
        try: jsons[os.path.relpath(f, out)] = json.load(open(f))
        except Exception: pass
    hits = []
    for tok, field in tokens.items():
        variants = {tok}
        if field.endswith('Date') or field == 'PatientBirthDate':
            if len(tok) == 8 and tok.isdigit():
                variants.add(f'{tok[:4]}-{tok[4:6]}-{tok[6:]}')
        for v in variants:
            pat = word(v)
            for (fn, blob) in texts:
                if pat.search(blob):
                    keys = [k for k, x in (jsons.get(fn) or {}).items() if isinstance(x, str) and pat.search(x.encode('utf-8', 'ignore'))]
                    if not any(h['file'] == fn and h['value'] == v for h in hits):
                        hits.append({'field': field, 'value': v, 'file': fn, 'sidecar_keys': keys,
                                     'technical_only': bool(keys) and all(k in TECHNICAL_KEYS for k in keys)})
    rec['identifying_tokens_checked'] = len(tokens)
    rec['identifying_tokens_found_in_outputs'] = hits[:20]
    phi_hits += hits
    R['dicom_to_nifti'].append(rec)
    print('A', name, 'outputs', len(rows), 'identical-to-native', sum(x['ok'] for x in rows), '| tokens', len(tokens), 'hits', len(hits),
          'non-technical', sum(not h['technical_only'] for h in hits))
    for x in rows:
        if not x['ok']:
            print('   MISMATCH', x)
    for h in [h for h in hits if not h['technical_only']][:10]:
        print('   PHI?', h)
    if hits:
        print('   technical-field coincidences:', sorted({(h['value'], k) for h in hits for k in h['sidecar_keys']}))

# ---------------------------------------------------------------- run B: NIfTI -> DICOM
b_dir = os.path.join(e2e_out, 'B_nifti_to_dicom')
b_report = json.load(open(glob.glob(os.path.join(b_dir, '*.json'))[0]))
srcs = {}
for z in ('nifti_seg_exam.zip', 'ct_head_exam.zip'):
    p = os.path.join(e2e_in, z)
    if os.path.exists(p):
        srcs[z] = unzip(p, os.path.join(work, 'B_src', z))


def dciodvfy(files):
    errs = set()
    for f in files:
        v = run(['dciodvfy', f])
        errs |= {l.strip() for l in (v.stdout + v.stderr).splitlines() if l.startswith('Error')}
    return sorted(errs)


def roundtrip(series_dir, src_nii, tag):
    back = os.path.join(work, 'B_back', tag)
    shutil.rmtree(back, ignore_errors=True); os.makedirs(back)
    run(['dcm2niix', '-b', 'n', '-z', 'n', '-f', 'rt', '-o', back, series_dir])
    niis = sorted(glob.glob(os.path.join(back, '*.nii')))
    if len(niis) != 1:
        return {'ok': False, 'outputs': [os.path.basename(x) for x in niis]}
    c = run([sys.executable, os.path.join(HERE, 'compare_nifti.py'), niis[0], src_nii])
    try:
        res = json.loads(c.stdout.strip().splitlines()[-1])
    except Exception:
        res = {'ok': c.returncode == 0, 'raw': c.stdout[-300:]}
    return res


for ex in b_report['exams']:
    name = ex['name']
    out = unzip(os.path.join(b_dir, ex['result']['zipName']), os.path.join(work, 'B', name))
    src_root = srcs[name]
    rec = {'exam': name, 'status_in_browser': ex['status'], 'series': []}
    for s in ex['result']['series']:
        src_nii = os.path.join(src_root, s['input'].split('/', 1)[1])
        for o in s['outputs']:
            d = os.path.join(out, o.split(' (')[0].rstrip('/'))
            files = sorted(glob.glob(os.path.join(d, '*.dcm')))
            row = {'input': s['input'], 'output': o, 'files': len(files)}
            first = pydicom.dcmread(files[0], stop_before_pixels=True)
            row['sop_class'] = str(first.SOPClassUID.name)
            row['dciodvfy_errors'] = dciodvfy([files[0], files[-1]] if len(files) > 1 else files)
            if first.Modality == 'SEG':
                import highdicom as hd
                seg = hd.seg.segread(files[0])
                lab_img = nib.load(src_nii); lab = np.asanyarray(lab_img.dataobj).astype(int)
                M = np.linalg.inv(lab_img.affine)
                ref_dir = [x for x in glob.glob(os.path.join(out, '*', '*')) if os.path.isdir(x) and x != d][0]
                refs = {}
                for f in sorted(glob.glob(os.path.join(ref_dir, '*.dcm'))):
                    r_ = pydicom.dcmread(f, stop_before_pixels=True); refs[r_.SOPInstanceUID] = r_
                ok = True
                labels = sorted(int(v) for v in np.unique(lab) if v != 0)
                for segnum, val in enumerate(labels, start=1):
                    rec_mask = np.zeros(lab.shape, bool)
                    uids = list(refs.keys())
                    arr = seg.get_pixels_by_source_instance(source_sop_instance_uids=uids, segment_numbers=[segnum], assert_missing_frames_are_empty=True)
                    for uid, plane in zip(uids, arr[..., 0]):
                        r_ = refs[uid]
                        ipp = np.array(r_.ImagePositionPatient, float); iop = np.array(r_.ImageOrientationPatient, float); ps = np.array(r_.PixelSpacing, float)
                        rr, cc = np.mgrid[0:r_.Rows, 0:r_.Columns]
                        lps = ipp + cc[..., None] * ps[1] * iop[:3] + rr[..., None] * ps[0] * iop[3:]
                        idx = np.rint((M[:3, :3] @ (lps.reshape(-1, 3) * [-1, -1, 1]).T).T + M[:3, 3]).astype(int)
                        rec_mask[idx[:, 0], idx[:, 1], idx[:, 2]] = plane.reshape(-1) > 0
                    ok = ok and np.array_equal(rec_mask, lab == val)
                row['segments'] = [x.SegmentLabel for x in seg.SegmentSequence]
                row['highdicom_voxel_exact'] = bool(ok)
                row['ok'] = bool(ok) and not row['dciodvfy_errors']
            elif 'face removed' in ' '.join(s['notes']):
                # defaced CT: compare every voxel; changes must be air and outside the intracranial space
                img = nib.load(src_nii); vals = img.get_fdata(dtype=np.float64); inv = np.linalg.inv(img.affine)
                got = np.full(vals.shape, np.nan)
                idx_err = 0.0
                for f in files:
                    ds = pydicom.dcmread(f)
                    ipp = np.array(ds.ImagePositionPatient, float); iop = np.array(ds.ImageOrientationPatient, float); ps = np.array(ds.PixelSpacing, float)
                    rr, cc = np.mgrid[0:ds.Rows, 0:ds.Columns]
                    lps = ipp + cc[..., None] * ps[1] * iop[:3] + rr[..., None] * ps[0] * iop[3:]
                    idx = (inv[:3, :3] @ (lps.reshape(-1, 3) * [-1, -1, 1]).T).T + inv[:3, 3]
                    ri = np.rint(idx); idx_err = max(idx_err, float(np.abs(idx - ri).max())); ri = ri.astype(int)
                    px = ds.pixel_array.astype(np.float64) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
                    got[ri[:, 0], ri[:, 1], ri[:, 2]] = px.reshape(-1)
                changed = got != vals
                row['changed_voxels_that_were_air'] = int((changed & (vals <= -1000)).sum())
                vox_ml = float(np.abs(np.linalg.det(img.affine[:3, :3]))) / 1000.0
                # independent intracranial mask: brain/CSF-range voxels (-15..100 HU) eroded by 5 voxels, which cuts the
                # thin connections through the skull base; the largest component (the brain) is then grown back by 5
                # voxels inside the same intensity range
                soft = (vals > -15) & (vals < 100)
                er = ndimage.binary_erosion(soft, iterations=5)
                lab_, n = ndimage.label(er)
                sizes = np.bincount(lab_.ravel())[1:]
                best = int(np.argmax(sizes)) + 1
                brain = ndimage.binary_dilation(lab_ == best, iterations=5, mask=soft)
                row.update({
                    'all_voxels_present': bool(not np.isnan(got).any()), 'max_index_error': idx_err,
                    'changed_voxels': int(changed.sum()), 'changed_ml': round(changed.sum() * vox_ml, 1),
                    'changed_all_air': bool((got[changed] == -1000).all()),
                    'independent_intracranial_ml': round(float(brain.sum()) * vox_ml, 1),
                    'changed_voxels_inside_intracranial_mask': int((changed & brain).sum()),
                })
                ras = nib.affines.apply_affine(img.affine, np.argwhere(changed)[:: max(1, changed.sum() // 20000)])
                ras_b = nib.affines.apply_affine(img.affine, np.argwhere(brain)[:: max(1, brain.sum() // 20000)])
                row['changed_centroid_minus_brain_centroid_RAS_mm'] = [round(float(x), 1) for x in ras.mean(0) - ras_b.mean(0)]
                row['ok'] = (row['all_voxels_present'] and row['changed_all_air'] and row['changed_voxels_inside_intracranial_mask'] == 0
                             and row['changed_voxels_that_were_air'] == 0 and not row['dciodvfy_errors'])
            else:
                c = run([sys.executable, os.path.join(HERE, 'dicom_vs_nifti.py'), d, src_nii])
                row['pydicom_nibabel'] = json.loads(c.stdout.strip().splitlines()[-1])
                row['dcm2niix_roundtrip'] = roundtrip(d, src_nii, f'{name}_{os.path.basename(d)}')
                row['ok'] = bool(row['pydicom_nibabel']['ok']) and bool(row['dcm2niix_roundtrip'].get('ok')) and not row['dciodvfy_errors']
            rec['series'].append(row)
            print('B', name, os.path.basename(d), 'OK' if row['ok'] else 'FAIL', {k: v for k, v in row.items() if k not in ('input', 'output')})
    R['nifti_to_dicom'].append(rec)

R['deidentification'] = {'identifying_tokens_found': len(phi_hits), 'found_outside_technical_fields': sum(not h['technical_only'] for h in phi_hits), 'hits': phi_hits[:50]}
R['summary'] = {
    'dicom_to_nifti_outputs': sum(r['n_outputs'] for r in R['dicom_to_nifti']),
    'dicom_to_nifti_identical_to_native': sum(sum(o['ok'] for o in r['outputs']) for r in R['dicom_to_nifti']),
    'nifti_to_dicom_series': sum(len(r['series']) for r in R['nifti_to_dicom']),
    'nifti_to_dicom_ok': sum(sum(s['ok'] for s in r['series']) for r in R['nifti_to_dicom']),
    'identifying_tokens_found': len(phi_hits),
    'identifying_tokens_found_outside_technical_fields': sum(not h['technical_only'] for h in phi_hits),
}
json.dump(R, open(report_path, 'w'), indent=1, default=str)
print('SUMMARY', R['summary'])
