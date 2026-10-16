#!/usr/bin/env python3
"""Independent voxel-exact check of a DICOM series against its source NIfTI.

Uses only pydicom + nibabel + numpy (no OMNIA code, no dcm2niix):
  * every pixel centre's world position is computed from ImagePositionPatient,
    ImageOrientationPatient and PixelSpacing (LPS), converted to RAS and mapped to a source
    voxel index through the inverse NIfTI affine (nibabel's best affine, or --qform);
  * the index must be an integer (tolerance 1e-3 voxel); each source voxel must be covered once;
  * the modality-LUT value (stored * RescaleSlope + RescaleIntercept) must equal the NIfTI
    scaled value (float32-exact for float sources, 1e-9 relative otherwise).
Usage: dicom_vs_nifti.py series_dir source.nii[.gz] [--quantized MAXERR] [--qform]
"""
import sys, glob, json, os
import numpy as np, nibabel as nib, pydicom


def main():
    d, src = sys.argv[1], sys.argv[2]
    qmax = float(sys.argv[sys.argv.index('--quantized') + 1]) if '--quantized' in sys.argv else None
    img = nib.load(src)
    aff = img.header.get_qform() if '--qform' in sys.argv else img.affine
    data = np.asanyarray(img.dataobj)
    raw_dtype = img.get_data_dtype()
    vals = img.get_fdata(dtype=np.float64)
    if vals.ndim == 3:
        vals = vals[..., None]
    nx, ny, nz, nt = vals.shape[:3] + (vals.shape[3] if vals.ndim > 3 else 1,)
    inv = np.linalg.inv(aff)
    covered = np.zeros((nx, ny, nz, nt), dtype=np.uint8)
    issues, maxdiff, max_idx_err = [], 0.0, 0.0
    files = sorted(glob.glob(os.path.join(d, '*.dcm')))
    series_uids = set()
    for f in files:
        ds = pydicom.dcmread(f)
        series_uids.add(ds.SeriesInstanceUID)
        ipp = np.array(ds.ImagePositionPatient, float)
        iop = np.array(ds.ImageOrientationPatient, float)
        ps = np.array(ds.PixelSpacing, float)
        rows, cols = int(ds.Rows), int(ds.Columns)
        slope = float(ds.get('RescaleSlope', 1) or 1)
        inter = float(ds.get('RescaleIntercept', 0) or 0)
        t = int(ds.get('TemporalPositionIdentifier', 0) or 0) - 1 if 'TemporalPositionIdentifier' in ds else (
            int(ds.AcquisitionNumber) - 1 if nt > 1 and 'AcquisitionNumber' in ds and ds.AcquisitionNumber not in (None, '') else 0)
        px = ds.pixel_array.astype(np.float64) * slope + inter
        rr, cc = np.mgrid[0:rows, 0:cols]
        row_dir, col_dir = iop[:3], iop[3:]
        lps = ipp[None, None, :] + cc[..., None] * ps[1] * row_dir + rr[..., None] * ps[0] * col_dir
        ras = lps * np.array([-1, -1, 1])
        idx = (inv[:3, :3] @ ras.reshape(-1, 3).T).T + inv[:3, 3]
        ridx = np.rint(idx)
        err = np.abs(idx - ridx).max()
        max_idx_err = max(max_idx_err, float(err))
        if err > 1e-3:
            issues.append(f'{os.path.basename(f)}: index error {err:.2e}'); continue
        ri = ridx.astype(int)
        if (ri < 0).any() or (ri[:, 0] >= nx).any() or (ri[:, 1] >= ny).any() or (ri[:, 2] >= nz).any() or not (0 <= t < nt):
            issues.append(f'{os.path.basename(f)}: outside volume'); continue
        ref = vals[ri[:, 0], ri[:, 1], ri[:, 2], t]
        got = px.reshape(-1)
        if qmax is not None:
            ok = np.abs(got - ref) <= qmax * (1 + 1e-9) + 1e-12
        elif raw_dtype == np.float32:
            ok = (got.astype(np.float32) == ref.astype(np.float32)) | (np.abs(got - ref) <= 1e-9 * np.maximum(1, np.abs(ref)))
            if '--ulp' in sys.argv:
                ok = ok | (np.abs(got - ref) <= np.spacing(np.abs(ref).astype(np.float32)).astype(np.float64))
        else:
            ok = np.abs(got - ref) <= 1e-9 * np.maximum(1, np.abs(ref))
        if not ok.all():
            issues.append(f'{os.path.basename(f)}: {int((~ok).sum())} value mismatches')
        maxdiff = max(maxdiff, float(np.abs(got - ref).max()))
        np.add.at(covered, (ri[:, 0], ri[:, 1], ri[:, 2], np.full(len(ri), t)), 1)
    out = {
        'files': len(files), 'voxels': int(covered.size), 'covered_once': bool((covered == 1).all()),
        'max_index_error': max_idx_err, 'max_abs_diff': maxdiff, 'single_series': len(series_uids) == 1,
        'issues': issues[:10],
    }
    out['ok'] = out['covered_once'] and not issues and out['single_series']
    print(json.dumps(out))
    return 0 if out['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
