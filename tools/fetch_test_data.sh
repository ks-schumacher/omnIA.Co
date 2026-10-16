#!/usr/bin/env bash
# Download the public test data used by the OMNIA validation battery, pinned to the exact commits used
# for the numbers in docs/VALIDATION.md. No patient data is stored in this repository.
#   dcm_qa*: Chris Rorden's dcm2niix regression datasets (BSD-2-Clause), https://github.com/neurolabusc
#   niivue-demo-images: CT_Philips.nii.gz (head CT, courtesy of Philips Medical) for the defacing test
# usage: tools/fetch_test_data.sh <data_dir>
set -euo pipefail
DATA="${1:?usage: tools/fetch_test_data.sh <data_dir>}"
mkdir -p "$DATA"
fetch() { # repo commit
  local dir="$DATA/$1"
  if [ ! -d "$dir/.git" ]; then git clone --quiet --filter=blob:none "https://github.com/neurolabusc/$1.git" "$dir"; fi
  git -C "$dir" -c advice.detachedHead=false checkout --quiet "$2"
  echo "$1 @ $2"
}
fetch dcm_qa             46dfb6fbaa1cc6f089acd999e820d6c7781d21e5
fetch dcm_qa_canon       1dc19c806d0347e9eb41db2edeb2db51365b5304
fetch dcm_qa_ct          642cc07925fc2b3a6925f8c0aa79856ca50770fa
fetch dcm_qa_enh         58953e7b0150c6b866b2cc2fc2b40366625672dc
fetch dcm_qa_ge          e92133ae414e2b23e8c4d07a4030ab4dbb41518e
fetch dcm_qa_mosaic      2dbdc581a6c36a2501d41f2eaf6928dc9fb98601
fetch dcm_qa_nih         6a11dc671ac6a0631585d59c840e7ff364494943
fetch dcm_qa_philips     74efdbc01eb62540fbb702787c3a7a2c0e22f9eb
fetch dcm_qa_philips_enh 4ee75064f8fe2ae622ca0d2555f9e53b90e2f620
fetch dcm_qa_stc         a3c74322d4e8deee7faaaaddc9cadd06c3b7de0b
fetch dcm_qa_uih         f3bd991a98eaf49a6f928f276a41f666d658a64b
fetch dcm_qa_xa30        54a9f42222e2ebef6f24e01f9c618fe85ff63b2b
NV="$DATA/niivue-demo-images"
if [ ! -d "$NV/.git" ]; then git clone --quiet --filter=blob:none https://github.com/niivue/niivue-demo-images.git "$NV"; fi
git -C "$NV" -c advice.detachedHead=false checkout --quiet f6f98294c1fa89a3a32e8a44eab92368374150a0
echo "niivue-demo-images @ f6f98294c1fa89a3a32e8a44eab92368374150a0"
