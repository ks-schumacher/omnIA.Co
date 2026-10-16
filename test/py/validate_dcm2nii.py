#!/usr/bin/env python3
"""DICOM -> NIfTI validation on every public dcm_qa dataset.

For each <data_root>/dcm_qa*/In folder:
  1. the folder is packed as one exam (ZIP) and converted by OMNIA (Node, same engine as the browser worker),
     with the default settings (de-identification on, BIDS names, localizers and derived secondaries filtered);
  2. OMNIA's own independent verification result is recorded per series;
  3. the same folder is converted with the native dcm2niix and every OMNIA NIfTI must have a native counterpart
     with an identical voxel array, identical scaling and an affine within 1e-4 mm (gantry-tilt series, where
     OMNIA deliberately writes the exact sheared geometry, are compared with a slice-position check instead);
  4. identifying strings and UIDs collected from the source headers must not occur in any output file.

usage: validate_dcm2nii.py <data_root> <work_dir> <report.json>
"""
import glob, gzip, json, os, re, shutil, subprocess, sys, zipfile
import numpy as np, nibabel as nib, pydicom

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
data_root, work, report = sys.argv[1:4]
os.makedirs(work, exist_ok=True)
TECHNICAL_KEYS = {'SequenceName', 'PulseSequenceName', 'PulseSequenceDetails', 'SequenceVariant', 'ScanningSequence',
                  'ManufacturersModelName', 'SoftwareVersions', 'ImageType', 'ScanOptions',
                  'OMNIAVersion', 'OMNIAVerification', 'OMNIADeidentification',
                  # anatomical term (e.g. a phantom named 'HEAD')
                  'BodyPart', 'BodyPartExamined'}
FIELDS = ['PatientName', 'PatientID', 'OtherPatientIDs', 'PatientBirthDate', 'InstitutionName', 'InstitutionAddress',
          'ReferringPhysicianName', 'PerformingPhysicianName', 'OperatorsName', 'AccessionNumber', 'StationName',
          'DeviceSerialNumber', 'StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID', 'FrameOfReferenceUID',
          'StudyDate', 'SeriesDate', 'AcquisitionDate', 'ContentDate', 'StudyID']


def word(v):
    """Case-insensitive whole-token match (a name such as 'Test' must not match 'LATEST')."""
    return re.compile(rb'(?<![A-Za-z0-9])' + re.escape(v.encode('utf-8', 'ignore')) + rb'(?![A-Za-z0-9])', re.I)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def unscaled(img):
    return np.asanyarray(img.dataobj.get_unscaled())


def direct_check(im, f, src):
    """Check an OMNIA NIfTI directly against the DICOM images of its series (no dcm2niix involved).

    Used where native dcm2niix has no identical counterpart by design: gantry-tilted series (OMNIA writes the
    exact sheared affine) and series with irregular spacing (OMNIA splits them into uniform blocks).
    The series is found by SeriesNumber (BIDS 'run' entity) and split by SeriesInstanceUID; for a candidate
    series, every pixel centre of every instance is mapped through the inverse OMNIA affine: instances that fall
    on the grid (integer indices within 1e-3 voxel, inside the volume) must have identical values, and every
    slice of the NIfTI must be filled exactly once."""
    m = re.search(r'run-(\d+)', os.path.basename(f))
    if not m:
        return {'ok': False, 'reason': 'no run entity'}
    sn = int(m.group(1))
    inv = np.linalg.inv(im.affine)
    vals = im.get_fdata(dtype=np.float64)
    if vals.ndim > 3:
        return {'ok': False, 'reason': '4D direct check not implemented'}
    nx, ny, nz = vals.shape
    groups = {}
    for p in glob.glob(os.path.join(src, '**', '*'), recursive=True):
        if not os.path.isfile(p):
            continue
        try:
            d = pydicom.dcmread(p, stop_before_pixels=True, force=True)
            if int(d.get('SeriesNumber', -1)) != sn or 'ImagePositionPatient' not in d:
                continue
        except Exception:
            continue
        groups.setdefault(str(d.SeriesInstanceUID), []).append(p)
    best = {'ok': False, 'reason': 'no matching series'}
    for uid, paths in groups.items():
        filled = np.zeros(nz, int)
        bad, err, used = 0, 0.0, 0
        for p in paths:
            d = pydicom.dcmread(p, force=True)
            ipp = np.array(d.ImagePositionPatient, float); iop = np.array(d.ImageOrientationPatient, float); ps = np.array(d.PixelSpacing, float)
            rr, cc = np.mgrid[0:d.Rows, 0:d.Columns]
            lps = ipp + cc[..., None] * ps[1] * iop[:3] + rr[..., None] * ps[0] * iop[3:]
            idx = (inv[:3, :3] @ (lps.reshape(-1, 3) * [-1, -1, 1]).T).T + inv[:3, 3]
            ri = np.rint(idx)
            e = float(np.abs(idx - ri).max())
            ri = ri.astype(int)
            if e > 1e-3 or (ri < 0).any() or (ri[:, 0] >= nx).any() or (ri[:, 1] >= ny).any() or (ri[:, 2] >= nz).any():
                continue  # this instance belongs to another block of the series
            ks = np.unique(ri[:, 2])
            if len(ks) != 1:
                bad += 1; continue
            err = max(err, e); used += 1
            px = d.pixel_array.astype(np.float64) * float(d.get('RescaleSlope', 1) or 1) + float(d.get('RescaleIntercept', 0) or 0)
            ref = vals[ri[:, 0], ri[:, 1], ri[:, 2]]
            if not np.allclose(px.reshape(-1), ref, rtol=0, atol=1e-6 * max(1.0, float(np.abs(ref).max()))):
                bad += 1
            filled[ks[0]] += 1
        res = {'series_uid_suffix': uid[-8:], 'instances_on_grid': used, 'slices_filled_once': bool((filled == 1).all()),
               'value_or_plane_mismatches': bad, 'max_index_error': err}
        res['ok'] = res['slices_filled_once'] and bad == 0 and used == nz
        if res['ok'] or (not best.get('ok') and used > best.get('instances_on_grid', -1)):
            best = res
        if res['ok']:
            break
    return best


results = []
for ds_dir in sorted(glob.glob(os.path.join(data_root, 'dcm_qa*'))):
    src = os.path.join(ds_dir, 'In')
    if not os.path.isdir(src):
        continue
    name = os.path.basename(ds_dir)
    w = os.path.join(work, name)
    shutil.rmtree(w, ignore_errors=True); os.makedirs(w)
    zp = os.path.join(w, f'{name}.zip')
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_STORED) as z:
        for r_, _, fs in os.walk(src):
            for f in fs:
                p = os.path.join(r_, f); z.write(p, os.path.relpath(p, src))
    out = os.path.join(w, 'omnia')
    r = run(['node', os.path.join(ROOT, 'test/cli/exam.mjs'), zp, out, '--direction', 'dcm2nii'])
    # OMNIA reads gzip-compressed DICOM files (.dcm.gz) directly; native dcm2niix and pydicom do not:
    # give them a decompressed copy of the source folder
    if any(f.endswith('.gz') for _, _, fs in os.walk(src) for f in fs):
        plain = os.path.join(w, 'source_decompressed')
        for r_, _, fs in os.walk(src):
            for f in fs:
                p = os.path.join(r_, f); q = os.path.join(plain, os.path.relpath(p, src))
                os.makedirs(os.path.dirname(q), exist_ok=True)
                if f.endswith('.gz'):
                    with gzip.open(p, 'rb') as a_, open(q[:-3], 'wb') as b_: shutil.copyfileobj(a_, b_)
                else:
                    shutil.copy(p, q)
        src = plain
    rec = {'dataset': name}
    try:
        summ = json.loads(r.stdout)
    except Exception:
        rec.update({'ok': False, 'error': (r.stderr or r.stdout)[-500:]}); results.append(rec); print(name, 'CLI ERROR', rec['error'][-200:]); continue
    rec['exam_status'] = summ['status']
    rec['series_total'] = len(summ['series'])
    rec['series_by_status'] = {s: sum(x['status'] == s for x in summ['series']) for s in ('ok', 'warning', 'skipped', 'error')}
    ver = [v.strip() for x in summ['series'] if x['status'] in ('ok', 'warning') for v in (x['verification'] or '').split(';') if v.strip()]
    rec['omnia_verification'] = {k: sum(v.startswith(k) for v in ver) for k in ('voxel-exact', 'geometry-exact', 'not applicable', 'dcm2niix only', 'FAILED')}
    rec['errors'] = summ['errors']
    rec['skipped_reasons'] = sorted({n for x in summ['series'] if x['status'] == 'skipped' for n in x['notes'][:1]})[:10]
    # native dcm2niix
    nat = os.path.join(w, 'native'); os.makedirs(nat)
    run(['dcm2niix', '-b', 'y', '-ba', 'n', '-z', 'n', '-i', 'n', '-w', '2', '-m', '2', '-f', '%s_%p_%t', '-o', nat, src])
    natives = []
    for f in sorted(glob.glob(os.path.join(nat, '*.nii'))):
        im = nib.load(f); natives.append((f, im, unscaled(im)))
    rows = []
    for f in sorted(glob.glob(os.path.join(out, '**', '*.nii*'), recursive=True)):
        im = nib.load(f); arr = unscaled(im)
        cands = [(nf, nim) for nf, nim, narr in natives
                 if narr.shape == arr.shape and narr.dtype == arr.dtype and np.array_equal(narr, arr)]
        row = {'omnia': os.path.relpath(f, out)}
        if not cands:
            # e.g. irregular spacing split into uniform blocks: check against the DICOM images directly
            row['native'] = None
            row['direct_check'] = direct_check(im, f, src)
            row['ok'] = row['direct_check'].get('ok', False)
        else:
            # several native outputs can hold the same voxels (e.g. a DWI series and its subset with other
            # gradient tables): accept the candidate whose scaling, affine and gradients all agree
            best = None
            for nf, nim in cands:
                r_ = {'native': os.path.basename(nf)}
                r_['scaling_equal'] = (float(im.dataobj.slope), float(im.dataobj.inter)) == (float(nim.dataobj.slope), float(nim.dataobj.inter))
                r_['affine_max_diff_mm'] = float(np.abs(im.affine - nim.affine).max())
                r_['ok'] = r_['scaling_equal'] and r_['affine_max_diff_mm'] <= 1e-4
                for ext in ('bval', 'bvec'):
                    base = re.sub(r'\.nii(\.gz)?$', '', f)
                    a, b = base + '.' + ext, nf[:-4] + '.' + ext
                    if os.path.exists(a) or os.path.exists(b):
                        eq = os.path.exists(a) and os.path.exists(b) and np.allclose(np.loadtxt(a), np.loadtxt(b), atol=1e-6)
                        r_[f'{ext}_equal'] = bool(eq); r_['ok'] = r_['ok'] and eq
                if best is None or (r_['ok'] and not best['ok']):
                    best = r_
                if r_['ok']:
                    break
            row.update(best)
            if not row['ok'] and row['scaling_equal'] and row.get('bval_equal', True) and row.get('bvec_equal', True):
                # e.g. gantry tilt: OMNIA writes the exact sheared sform, native dcm2niix an approximate slice vector
                row['direct_check'] = direct_check(im, f, src)
                row['ok'] = row['direct_check'].get('ok', False)
        rows.append(row)
    rec['outputs'] = len(rows)
    rec['confirmed_independently'] = sum(x['ok'] for x in rows)  # identical to native dcm2niix, or exact against the DICOM images
    rec['mismatches'] = [x for x in rows if not x['ok']][:10]
    rec['checked_directly_against_dicom'] = sum('direct_check' in x for x in rows)
    rec['identical_to_native_dcm2niix'] = sum(x['ok'] and 'direct_check' not in x for x in rows)
    # de-identification scan
    tokens = {}
    for f in glob.glob(os.path.join(src, '**', '*'), recursive=True):
        if not os.path.isfile(f):
            continue
        try:
            d = pydicom.dcmread(f, stop_before_pixels=True, force=True)
        except Exception:
            continue
        for k in FIELDS:
            v = d.get(k)
            if v in (None, ''):
                continue
            for part in re.split(r'[\^\\=]', str(v)):
                part = part.strip()
                if (len(part) >= 4 and not part.isdigit()) or (part.isdigit() and len(part) >= 8):
                    tokens.setdefault(part, k)
    hits = []
    for f in glob.glob(os.path.join(out, '**', '*'), recursive=True):
        if not os.path.isfile(f):
            continue
        rel = os.path.relpath(f, out)
        blobs = [rel.encode()]
        js = None
        if f.endswith('.nii.gz') or f.endswith('.nii'):
            raw = gzip.open(f).read() if f.endswith('.gz') else open(f, 'rb').read()
            blobs.append(raw[:max(int(nib.load(f).header['vox_offset']), 352)])
        elif f.endswith(('.json', '.bval', '.bvec', '.tsv', '.txt')):
            blobs.append(open(f, 'rb').read())
            if f.endswith('.json'):
                try: js = json.load(open(f))
                except Exception: js = None
        for tok, field in tokens.items():
            vs = {tok}
            if 'Date' in field and len(tok) == 8 and tok.isdigit():
                vs.add(f'{tok[:4]}-{tok[4:6]}-{tok[6:]}')
            for v in vs:
                pat = word(v)
                if any(pat.search(b) for b in blobs):
                    keys = [k for k, x in (js or {}).items() if isinstance(x, str) and pat.search(x.encode('utf-8', 'ignore'))]
                    hits.append({'field': field, 'value': v, 'file': rel, 'sidecar_keys': keys,
                                 'technical_only': bool(keys) and all(k in TECHNICAL_KEYS for k in keys)})
    rec['identifying_tokens_checked'] = len(tokens)
    rec['identifying_hits_outside_technical_fields'] = [h for h in hits if not h['technical_only']][:10]
    rec['technical_field_coincidences'] = sorted({f"{h['value']} in {k}" for h in hits if h['technical_only'] for k in h['sidecar_keys']})
    rec['ok'] = rec['confirmed_independently'] == rec['outputs'] and not rec['identifying_hits_outside_technical_fields'] and rec['omnia_verification']['FAILED'] == 0
    results.append(rec)
    print(name, 'status', rec['exam_status'], rec['series_by_status'], 'verification', rec['omnia_verification'],
          '| outputs', rec['outputs'], 'confirmed', rec['confirmed_independently'], '(native-identical', rec['identical_to_native_dcm2niix'], '+ direct', rec['checked_directly_against_dicom'], ')',
          '| PHI hits', len(rec['identifying_hits_outside_technical_fields']), 'tech', rec['technical_field_coincidences'])
    for x in rec['mismatches']:
        print('   MISMATCH', x)
    for h in rec['identifying_hits_outside_technical_fields']:
        print('   PHI?', h)

summary = {
    'datasets': len(results),
    'outputs': sum(r.get('outputs', 0) for r in results),
    'confirmed_independently': sum(r.get('confirmed_independently', 0) for r in results),
    'identical_to_native_dcm2niix': sum(r.get('identical_to_native_dcm2niix', 0) for r in results),
    'checked_directly_against_dicom': sum(r.get('checked_directly_against_dicom', 0) for r in results),
    'series_converted': sum(r.get('series_by_status', {}).get('ok', 0) + r.get('series_by_status', {}).get('warning', 0) for r in results),
    'series_skipped': sum(r.get('series_by_status', {}).get('skipped', 0) for r in results),
    'series_error': sum(r.get('series_by_status', {}).get('error', 0) for r in results),
    'identifying_hits': sum(len(r.get('identifying_hits_outside_technical_fields', [])) for r in results),
}
json.dump({'summary': summary, 'datasets': results}, open(report, 'w'), indent=1, default=str)
print('SUMMARY', summary)
