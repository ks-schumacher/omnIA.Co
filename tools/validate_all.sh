#!/usr/bin/env bash
# Full OMNIA validation battery. Requirements: Node >= 20, Python 3 with numpy, nibabel, pydicom, scipy,
# highdicom; native dcm2niix and dciodvfy (dicom3tools) on PATH; for the browser test a Chromium
# (puppeteer-core + @sparticuz/chromium from devDependencies).
# usage: tools/validate_all.sh <data_dir> <report_dir>
set -euo pipefail
DATA="${1:?usage: tools/validate_all.sh <data_dir> <report_dir>}"; OUT="${2:?report dir}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"
echo "== unit tests";                 npm test 2>&1 | tee "$OUT/unit.log" | tail -n 8
echo "== synthetic edge cases";       python3 test/py/validate_synthetic.py "$OUT/synthetic.json" | tee "$OUT/synthetic.log" | tail -n 2
echo "== DICOM -> NIfTI (dcm_qa)";    python3 test/py/validate_dcm2nii.py "$DATA" "$OUT/work_dcm2nii" "$OUT/dcm2nii.json" | tee "$OUT/dcm2nii.log" | tail -n 1
echo "== NIfTI -> DICOM (dcm_qa Ref)"; python3 test/py/validate_refs.py "$DATA" "$OUT/refs.json" | tee "$OUT/refs.log" | tail -n 6
echo "== dcm2niix WASM vs native";    python3 test/py/wasm_vs_native.py "$DATA" "$OUT/wasm_vs_native.json" | tee "$OUT/wasm.log" | tail -n 2
echo "== browser end-to-end"
python3 test/py/make_e2e_inputs.py "$DATA" "$OUT/e2e_in" "$DATA/niivue-demo-images/CT_Philips.nii.gz"
npm run build >/dev/null
node test/e2e/e2e.mjs "$OUT/e2e_in" "$OUT/e2e_out" | tee "$OUT/e2e.log"
python3 test/py/validate_e2e.py "$DATA" "$OUT/e2e_in" "$OUT/e2e_out" "$OUT/work_e2e" "$OUT/e2e_validation.json" | tee "$OUT/e2e_validation.log" | tail -n 1
