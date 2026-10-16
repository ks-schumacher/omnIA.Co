#!/usr/bin/env python3
"""Build the end-to-end test inputs from the public dcm_qa datasets (and optional local NIfTIs).
usage: make_e2e_inputs.py <data_root> <out_dir> [ct_head_nifti]"""
import io, json, os, sys, zipfile, shutil
import numpy as np, nibabel as nib
data, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

def zipdir(src, dst, prefix=''):
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, _, fs in os.walk(src):
            for f in fs:
                p = os.path.join(root, f)
                z.write(p, os.path.join(prefix, os.path.relpath(p, src)))

# 1. Philips classic + enhanced (ZIP)
zipdir(os.path.join(data, 'dcm_qa_philips/In'), os.path.join(out, 'philips_exam.zip'))
# 2. GE (RAR5, complete series)
try:
    import rars
    b = rars.RarBuilder(format='rar50', compression=3)
    src = os.path.join(data, 'dcm_qa_ge/In')
    for root, _, fs in os.walk(src):
        for f in fs:
            p = os.path.join(root, f); b.add_bytes(open(p, 'rb').read(), os.path.relpath(p, src))
    b.write(os.path.join(out, 'ge_exam.rar'))
except ImportError:
    print('rars not installed: RAR input skipped')
# 3. nested ZIP with DICOMDIR-like junk and an inner archive (Enhanced Siemens/Philips)
inner = io.BytesIO()
with zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED) as z:
    src = os.path.join(data, 'dcm_qa_enh/In')
    for root, _, fs in os.walk(src):
        for f in fs:
            p = os.path.join(root, f); z.write(p, os.path.relpath(p, src))
with zipfile.ZipFile(os.path.join(out, 'nested_exam.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('export/inner_series.zip', inner.getvalue())
    z.writestr('__MACOSX/._junk', b'junk')
    z.writestr('export/README.txt', 'exported from a test PACS')
# 4. NIfTI -> DICOM: image + label map (+ label names)
rng = np.random.default_rng(7)
A = np.eye(4); A[:3, :3] = np.diag([-0.9, 0.9, 2.0]); A[:3, 3] = [57, -80, -40]
x, y, zz = np.meshgrid(np.linspace(0, 1, 128), np.linspace(0, 1, 128), np.linspace(0, 1, 60), indexing='ij')
img = np.round(1000 * (0.3 * x + 0.5 * y + 0.2 * zz)).astype(np.int16)
lab = np.zeros(img.shape, np.uint8); lab[30:60, 40:70, 10:30] = 1; lab[70:90, 60:100, 20:50] = 2
tmp = os.path.join(out, '_tmp'); os.makedirs(tmp, exist_ok=True)
def save(arr, name):
    im = nib.Nifti1Image(arr, A); im.header.set_sform(A, 1); im.header.set_qform(A, 1); nib.save(im, os.path.join(tmp, name))
save(img, 't1.nii.gz'); save(lab, 'lesion_seg.nii.gz')
with open(os.path.join(tmp, 't1.json'), 'w') as f:
    json.dump({'Modality': 'MR', 'MagneticFieldStrength': 3, 'Manufacturer': 'Siemens', 'SeriesDescription': 'T1 MPRAGE', 'RepetitionTime': 2.3, 'EchoTime': 0.00298, 'InversionTime': 0.9, 'FlipAngle': 9, 'ScanningSequence': 'GR\\IR', 'SequenceVariant': 'SK\\SP\\MP', 'MRAcquisitionType': '3D', 'PatientPosition': 'HFS'}, f)
with open(os.path.join(tmp, 'lesion_seg.json'), 'w') as f:
    json.dump({'1': 'Lesion A', '2': 'Lesion B'}, f)
zipdir(tmp, os.path.join(out, 'nifti_seg_exam.zip'), 'case01')
shutil.rmtree(tmp)
# 5. optional head CT NIfTI for defacing in the NIfTI -> DICOM direction
if len(sys.argv) > 3:
    with zipfile.ZipFile(os.path.join(out, 'ct_head_exam.zip'), 'w') as z:
        z.write(sys.argv[3], 'ct_head/ct_head.nii.gz')
print(sorted(os.listdir(out)))
