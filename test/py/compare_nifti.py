#!/usr/bin/env python3
"""Compare two NIfTI volumes in world space (voxel-exact).

Usage: compare_nifti.py A.nii B.nii [--tol-affine 1e-3]
Reorients B onto A's voxel grid using only axis permutations/flips (no interpolation) and requires:
  * identical shape after reorientation, * affines equal within tolerance (mm),
  * identical voxel values (scaled, float64) up to float32 precision.
Prints a JSON verdict.
"""
import sys, json
import numpy as np, nibabel as nib
from nibabel.orientations import io_orientation, ornt_transform, apply_orientation, inv_ornt_aff

def load(p):
    im = nib.load(p)
    return im, np.asarray(im.dataobj).astype(np.float64) if im.header['scl_slope'] in (0, np.nan) else im.get_fdata(dtype=np.float64)

def main():
    a_p, b_p = sys.argv[1], sys.argv[2]
    tol = float(sys.argv[sys.argv.index('--tol-affine') + 1]) if '--tol-affine' in sys.argv else 1e-3
    A = nib.load(a_p); B = nib.load(b_p)
    a = A.get_fdata(dtype=np.float64); b = B.get_fdata(dtype=np.float64)
    oa = io_orientation(A.affine); ob = io_orientation(B.affine)
    tr = ornt_transform(ob, oa)
    b2 = apply_orientation(b, tr) if b.ndim == 3 else np.stack([apply_orientation(b[..., t], tr) for t in range(b.shape[3])], -1)
    B_aff = B.affine @ inv_ornt_aff(tr, B.shape[:3])
    out = {'a': a_p, 'b': b_p, 'shape_a': list(a.shape), 'shape_b_reoriented': list(b2.shape)}
    if a.shape != b2.shape:
        out['ok'] = False; out['reason'] = 'shape mismatch'; print(json.dumps(out)); return 1
    # compare affines via corner points (handles flips): world coords of all 8 corners
    corners = np.array([[i, j, k, 1] for i in (0, a.shape[0]-1) for j in (0, a.shape[1]-1) for k in (0, a.shape[2]-1)]).T
    da = (A.affine @ corners)[:3]; db = (B_aff @ corners)[:3]
    out['max_affine_mm'] = float(np.max(np.abs(da - db)))
    diff = np.abs(a - b2)
    out['max_abs_value_diff'] = float(np.max(diff))
    same32 = np.array_equal(a.astype(np.float32), b2.astype(np.float32))
    out['values_equal_float32'] = bool(same32)
    within = same32 or out['max_abs_value_diff'] <= 1e-9 * max(1, np.max(np.abs(a)))
    if not within and '--ulp' in sys.argv:
        # float sources re-read through a float32 scl_slope: allow one float32 ulp
        within = bool(np.all(diff <= np.spacing(np.abs(a).astype(np.float32)).astype(np.float64) * 1.0000001))
        out['ulp_tolerance_used'] = True
    out['ok'] = bool(out['max_affine_mm'] <= tol and within)
    print(json.dumps(out)); return 0 if out['ok'] else 1

if __name__ == '__main__':
    sys.exit(main())
