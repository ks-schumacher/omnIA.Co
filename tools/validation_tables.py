#!/usr/bin/env python3
"""Turn the JSON reports written by tools/validate_all.sh into the Markdown tables of docs/VALIDATION.md.
usage: validation_tables.py <report_dir> [template.md output.md]"""
import json, os, re, sys
from collections import defaultdict

D = sys.argv[1]
load = lambda f: json.load(open(os.path.join(D, f)))
sections = {}
out = []
P = out.append


def section(name):
    """Start a new named section; the previous lines are kept under their own name."""
    global out, P
    out = sections.setdefault(name, [])
    P = out.append


# --- NIfTI -> DICOM on reference NIfTIs
section('refs')
refs = load('refs.json')
by = defaultdict(list)
for r in refs:
    by[r['file'].split('/')[0]].append(r)
P('| Dataset | NIfTI files | Converted | Refused | OMNIA self-check | Independent check (pydicom + nibabel) | Native dcm2niix round trip | dciodvfy errors |')
P('|---|---:|---:|---:|---:|---:|---:|---:|')
tot = defaultdict(int)
for ds in sorted(by):
    rs = by[ds]
    conv = [r for r in rs if r.get('omnia') == 'ok']
    row = {
        'n': len(rs), 'conv': len(conv), 'ref': sum(r.get('omnia') == 'refused' for r in rs),
        'self': sum(bool(r.get('self_verify')) for r in conv), 'indep': sum(bool(r.get('independent_check')) for r in conv),
        'rt': sum(r.get('roundtrip') == 'ok' for r in conv), 'tilt': sum(r.get('roundtrip') == 'n/a-tilt' for r in conv),
        'dv': sum(bool(r.get('dciodvfy_errors')) for r in conv),
    }
    for k, v in row.items():
        tot[k] += v
    rt = f"{row['rt']}" + (f" (+{row['tilt']} tilt, n/a)" if row['tilt'] else '')
    P(f"| {ds} | {row['n']} | {row['conv']} | {row['ref']} | {row['self']}/{row['conv']} | {row['indep']}/{row['conv']} | {rt} | {row['dv']} |")
rt = f"{tot['rt']}" + (f" (+{tot['tilt']} tilt, n/a)" if tot['tilt'] else '')
P(f"| **Total** | **{tot['n']}** | **{tot['conv']}** | **{tot['ref']}** | **{tot['self']}/{tot['conv']}** | **{tot['indep']}/{tot['conv']}** | **{rt}** | **{tot['dv']}** |")
refused = [r for r in refs if r.get('omnia') == 'refused']
if refused:
    P('')
    P('Refused files: ' + '; '.join(f"`{r['file']}`" for r in refused) + '.')
P('')

# --- DICOM -> NIfTI
section('dcm2nii')
d2n = load('dcm2nii.json')
P('| Dataset | Series converted | Skipped by filters | Errors | OMNIA check: voxel-exact | geometry-exact | dcm2niix only (mosaic) | NIfTI outputs | Identical to native dcm2niix | Exact against the DICOM images | Identifiers found in outputs |')
P('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
t = defaultdict(int)
for r in d2n['datasets']:
    sb = r['series_by_status']; v = r['omnia_verification']
    vals = [sb['ok'] + sb['warning'], sb['skipped'], sb['error'], v['voxel-exact'], v['geometry-exact'], v['dcm2niix only'],
            r['outputs'], r['identical_to_native_dcm2niix'], r['checked_directly_against_dicom'], len(r['identifying_hits_outside_technical_fields'])]
    for i, x in enumerate(vals):
        t[i] += x
    P(f"| {r['dataset']} | " + ' | '.join(str(x) for x in vals) + ' |')
P('| **Total** | ' + ' | '.join(f'**{t[i]}**' for i in range(10)) + ' |')
P('')
P(f"Identifying strings and UIDs collected from the source headers and searched in every output: "
  f"{sum(r['identifying_tokens_checked'] for r in d2n['datasets'])}.")
co = sorted({c for r in d2n['datasets'] for c in r['technical_field_coincidences']})
if co:
    P('Coincidences in technical fields (not identifying): ' + '; '.join(f'`{c}`' for c in co) + '.')
P('')

# --- WASM vs native
section('wasm')
w = load('wasm_vs_native.json')
P('| Dataset | NIfTI (native) | NIfTI (browser) | Byte-identical, same name | Identical NIfTI + sidecar, any name |')
P('|---|---:|---:|---:|---:|')
for r in w:
    P(f"| {r['dataset']} | {r['nifti_native']} | {r['nifti_wasm']} | {r['byte_identical']} | {r['identical_nifti_and_sidecar_by_content']} |")
P(f"| **Total** | **{sum(r['nifti_native'] for r in w)}** | **{sum(r['nifti_wasm'] for r in w)}** | **{sum(r['byte_identical'] for r in w)}** | **{sum(r['identical_nifti_and_sidecar_by_content'] for r in w)}** |")
P('')

# --- synthetic
section('synthetic')
syn = load('synthetic.json')
P('| Case | What it tests | Result |')
P('|---|---|---|')
for r in syn:
    P(f"| `{r['case']}` | {r.get('note', '')} | {'pass' if r.get('ok') else 'FAIL'} |")
P('')

# --- e2e
section('e2e')
e = load('e2e_validation.json')
P('```json')
P(json.dumps(e['summary'], indent=1))
P('```')
# with a template: replace {{TABLE_<name>}} markers; otherwise print every section
if len(sys.argv) > 3:
    t = open(sys.argv[2]).read()
    for k, v in sections.items():
        t = t.replace('{{TABLE_%s}}' % k.upper(), '\n'.join(v).rstrip())
    open(sys.argv[3], 'w').write(t)
else:
    for k, v in sections.items():
        print(f'<!-- {k} -->'); print('\n'.join(v))
