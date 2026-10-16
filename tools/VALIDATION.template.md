# OMNIA validation report

OMNIA 1.0.0 · battery run on {{RUN_DATE}} · native dcm2niix v1.0.20260724 · dicom3tools `dciodvfy` · pydicom, nibabel, highdicom

This document explains how OMNIA was tested and gives every result. All of it can be reproduced with
`tools/fetch_test_data.sh` and `tools/validate_all.sh` (see the README). The test data are public: the
**dcm_qa** regression collections that Chris Rorden and collaborators maintain for dcm2niix (12 repositories,
Siemens, GE, Philips, Canon and United Imaging MR plus GE and Philips CT, classic and enhanced DICOM), and one
head CT from the niivue demo images (courtesy of Philips Medical). No patient data are stored in the repository.

The guiding principle is that **no result is checked by the code that produced it**. Each direction has an
internal check that runs for every user (and can refuse an exam), and the validation adds checks written with
different libraries (pydicom, nibabel, highdicom) and different programs (native dcm2niix, dciodvfy).

## Summary

{{SUMMARY_TABLE}}

## 1. NIfTI → DICOM on real reference volumes

**Input.** Every reference NIfTI shipped in the `Ref` folders of the 12 dcm_qa repositories (191 files; these are
dcm2niix's expected outputs for real acquisitions), with their BIDS sidecars and, for diffusion data, `.bval`/`.bvec`.

**Procedure** (`test/py/validate_refs.py`), for each file:

1. OMNIA converts it to a classic CT or MR DICOM series with the Node build of the same engine the browser
   uses, and runs its own voxel-by-voxel self-check.
2. *Independent check* (`test/py/dicom_vs_nifti.py`, pydicom + nibabel only): for every pixel of every instance, the
   world position computed from ImagePositionPatient, ImageOrientationPatient and PixelSpacing is mapped back
   through the inverse NIfTI affine; the index must be an integer (tolerance 10⁻³ voxel), every source voxel must
   be covered exactly once, and the modality-LUT value must equal the NIfTI value.
3. *Round trip*: the DICOM series is converted back with the native dcm2niix and compared with the source in world
   space (`test/py/compare_nifti.py`): identical values and corner positions within 10⁻³ mm. DWI: identical
   b-values and gradient directions within 10⁻⁴.
4. *Conformance*: `dciodvfy` on the first and last instance of every series.

**Results.**

{{TABLE_REFS}}

All 189 converted volumes were stored losslessly (no quantisation was needed); 174 axial, 9 sagittal and 6
coronal. The largest index error in the independent check was {{MAX_INDEX_ERR}} voxel, the largest difference in
corner position after the dcm2niix round trip {{MAX_RT_MM}} mm, and the largest value difference 0.

*Why two files were refused.* Both are colour (RGB) fractional-anisotropy maps. OMNIA converts grey-level CT and MR
images only, and says so instead of writing a wrong series.

*Why three round trips are marked n/a.* They are gantry-tilted CT series. OMNIA writes the exact geometry (slice
positions sheared along the tilt), which the independent check confirms voxel by voxel; dcm2niix's non-resampled
output approximates the slice direction for tilted data, so a world-space comparison with it is not meaningful.

## 2. DICOM → NIfTI on every public dataset

**Procedure** (`test/py/validate_dcm2nii.py`), for each of the 12 datasets:

1. The `In` folder is packed as one exam (ZIP) and converted by OMNIA with its default settings: de-identification
   on, BIDS names, localizers and secondary captures skipped, at least 3 images per series, irregular spacing split
   losslessly, exact geometry for gantry tilt.
2. OMNIA's own check runs during conversion: *voxel-exact* (every uncompressed classic image located in the NIfTI
   and compared value by value), *geometry-exact* (enhanced multi-frame or compressed data: every frame position
   checked) or *dcm2niix only* (mosaics, whose slices are not individually addressable).
3. The same folder is converted by the **native** dcm2niix. Every NIfTI written by OMNIA must have a native counterpart
   with an identical voxel array, identical scaling, an affine within 10⁻⁴ mm and identical gradient tables.
   Outputs that by design have no native counterpart (irregular spacing split into blocks; tilt written with the exact
   sheared affine) are checked **directly against the DICOM images** with pydicom: every pixel of every instance must
   land on an integer voxel index and carry the same value, and every slice must be filled exactly once.
4. De-identification: every name, ID, date, institution, station, serial number and UID found in the source headers
   is searched, as a whole word and case-insensitively, in every output file (JSON sidecars, NIfTI header and
   extensions, file names).

**Results.**

{{TABLE_DCM2NII}}

## 3. dcm2niix in the browser versus native dcm2niix

OMNIA uses dcm2niix compiled to WebAssembly (`@niivue/dcm2niix`). `test/py/wasm_vs_native.py` converts every
dataset with both builds and the same options and compares the files byte by byte.

{{TABLE_WASM}}

The two files counted as different by name in `dcm_qa_ct` are two secondary captures with the same series number
and description: dcm2niix names duplicates `a`, `b`, `c` in the order the file system lists them, which differs
between the browser's in-memory file system and Linux. Their contents (image and sidecar) are identical.

## 4. Synthetic edge cases

`test/py/validate_synthetic.py` writes NIfTI files with known properties and checks the expected outcome (lossless
conversion, bounded quantisation or a refusal with a reason), the independent pydicom check, the native dcm2niix
round trip where meaningful, dciodvfy, the DWI gradients and the DICOM SEG decoded with highdicom.

{{TABLE_SYNTHETIC}}

## 5. Browser end-to-end test

`test/e2e/e2e.mjs` serves the production build with its security headers, opens it in headless Chromium, passes the
access step, adds exams through the file input and runs two batches:

- **DICOM → NIfTI**: a Philips exam (ZIP, classic and enhanced), a GE exam (**RAR5**) and a nested archive (ZIP
  inside ZIP, with junk entries) holding enhanced Siemens/Philips data;
- **NIfTI → DICOM**: an MR volume with a label map and label names (→ MR series + DICOM SEG), and a head CT with
  **face removal** enabled.

`test/py/validate_e2e.py` then checks the downloaded files with no OMNIA code: every NIfTI against native dcm2niix,
identifiers in every output file, the MR series with pydicom/nibabel and a native dcm2niix round trip, the SEG with
highdicom, and the defaced CT: every changed voxel must have become air (−1000 HU), voxels that were already air must
be untouched, and no changed voxel may touch an intracranial mask computed independently (brain/CSF-range voxels
eroded to separate them from extracranial soft tissue, largest component, grown back).

{{TABLE_E2E}}

{{E2E_DETAIL}}

## 6. Unit tests

`npm test` runs {{UNIT_TESTS}} tests with the Node test runner, including a property test that maps every pixel of
200 random oblique, flipped and permuted grids back to its voxel, the exact 16-bit encoder, the DICOM writer/reader
round trip, de-identification, the ZIP reader/writer (with CRC corruption) and the NIfTI reader (big-endian,
multi-member gzip, qform conventions).

## 7. Problems found by this validation and fixed before release

Validation is only useful if it can fail. These were found while building this report and corrected in 1.0.0:

- **Sagittal 3D series that dcm2niix reorders** (United Imaging): OMNIA's DICOM → NIfTI check assumed the DICOM
  planes are stacked along the third NIfTI axis and refused a correct conversion. The check now finds the slice axis
  from the geometry.
- **United Imaging diffusion mosaics** have no ImagePositionPatient; they were skipped. They are now recognised as
  mosaics and converted by dcm2niix (outputs identical to native).
- **Archives containing several patients**: descriptions were cleaned using the identifiers of the first patient only.
  They are now cleaned against every identity found in the exam, and the pseudonym map lists the other IDs.
- **Face removal** also replaced background voxels already darker than −1000 HU; only voxels denser than air are
  changed now.
- **Decimal strings** for Rescale Slope and similar values now use exponent notation when it keeps more significant
  digits within the 16 characters DICOM allows.

## Limits of this validation

- The reference data are regression datasets, not a clinical sample; they were chosen because they cover many
  vendors, sequences and edge cases, and because anyone can download them.
- Mosaic series are verified only against native dcm2niix, not voxel by voxel against the DICOM images.
- The intracranial mask used to check face removal is a simple independent estimate, not a segmentation reference.
- Viewer compatibility (RadiAnt, PACS) is not automated here; the DICOM objects pass dciodvfy without errors.
