// Batch settings: every decision is made before the conversion starts.
export const DEFAULT_SETTINGS = {
  direction: 'dcm2nii', // 'dcm2nii' | 'nii2dcm'
  anonymize: true,
  pseudonymPrefix: 'OMNIA',
  dates: 'remove', // 'remove' | 'shift' | 'keep'
  retainPatientCharacteristics: true,
  keepDescriptions: true,
  deface: false,
  defaceFailure: 'exclude', // 'exclude' | 'include'
  password: '',
  // DICOM -> NIfTI
  outputFormat: 'nii.gz', // 'nii.gz' | 'nii'
  bids: true,
  filters: { localizers: true, derivedSecondary: true, minImages: 3 },
  variableSpacing: 'split', // 'split' | 'interpolate' | 'skip'
  gantryTilt: 'exact', // 'exact' | 'resampled'
  // NIfTI -> DICOM
  defaultModality: 'MR', // 'MR' | 'CT'
  geometryPriority: 'sform', // 'sform' | 'qform'
  valuePolicy: 'lossless', // 'lossless' | 'quantize'
  maskHandling: 'auto', // 'auto' | 'image' | 'seg'
  segAlgorithmType: 'AUTOMATIC',
  segAlgorithmName: 'Unspecified',
};
