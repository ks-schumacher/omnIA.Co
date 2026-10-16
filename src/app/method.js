// "How OMNIA guarantees the conversion" section. Numbers come from docs/VALIDATION.md.
export const METHOD = {
  pt: {
    numbers: [
      ['189/189', 'volumes reais de 5 fabricantes convertidos para DICOM e conferidos voxel a voxel'],
      ['0', 'erros de conformidade DICOM (dciodvfy) nesses volumes'],
      ['190/190', 'volumes NIfTI de 12 conjuntos públicos de DICOM, confirmados de forma independente'],
      ['186/186', 'saídas do dcm2niix no navegador idênticas às do dcm2niix nativo'],
    ],
    items: [
      ['Sem perdas por padrão', 'Os valores do NIfTI são gravados como inteiros de 16 bits com Rescale Slope/Intercept somente quando a representação é exata. Se não for, o exame é recusado, a menos que você permita a quantização; nesse caso o erro máximo é medido e registrado.'],
      ['Geometria exata', 'Cada voxel mantém sua posição: orientação e posição de cada corte vêm da matriz afim do NIfTI (convertida de RAS para LPS). Nada é reamostrado. Cisalhamento no plano, que o DICOM não representa, é recusado.'],
      ['Verificação independente', 'Depois de gravar, o OMNIA relê os arquivos por outro caminho de código e confere cada voxel contra a origem. No sentido DICOM → NIfTI, cada imagem DICOM sem compressão é localizada no NIfTI e comparada valor a valor.'],
      ['dcm2niix como referência', 'A conversão DICOM → NIfTI usa o dcm2niix (Chris Rorden, licença BSD) compilado em WebAssembly, o mesmo programa usado nos principais conversores BIDS.'],
      ['Desidentificação', 'Perfil básico do DICOM PS3.15, com pseudônimo consistente por paciente no lote, novos UIDs e opções para datas e características do paciente. O mapa de pseudônimos fica só na sua pasta.'],
      ['Remoção da face', 'Em TC de crânio, um plano tangente ao volume intracraniano (com 4 mm de margem) remove olhos, nariz, boca e mento. O encéfalo fica do outro lado do plano por construção. Confira sempre a renderização frontal.'],
      ['Seus dados não saem do computador', 'Tudo acontece no navegador (Web Worker e WebAssembly). A política de segurança da página bloqueia envios para qualquer servidor; apenas o e-mail de acesso é transmitido.'],
      ['Limites conhecidos', 'Dados RGB e complexos não são convertidos para DICOM. Mosaicos (Siemens, United Imaging) são convertidos pelo dcm2niix sem a verificação voxel a voxel do OMNIA. A remoção da face está disponível apenas para TC. Uso em pesquisa e ensino, sem finalidade diagnóstica.'],
    ],
  },
  en: {
    numbers: [
      ['189/189', 'real volumes from 5 vendors converted to DICOM and checked voxel by voxel'],
      ['0', 'DICOM conformance errors (dciodvfy) on those volumes'],
      ['190/190', 'NIfTI volumes from 12 public DICOM datasets, confirmed independently'],
      ['186/186', 'dcm2niix outputs in the browser identical to native dcm2niix'],
    ],
    items: [
      ['Lossless by default', 'NIfTI values are written as 16-bit integers with Rescale Slope/Intercept only when the representation is exact. Otherwise the exam is refused unless you allow quantisation, in which case the maximum error is measured and recorded.'],
      ['Exact geometry', 'Every voxel keeps its position: each slice orientation and position comes from the NIfTI affine (converted from RAS to LPS). Nothing is resampled. In-plane shear, which DICOM cannot represent, is refused.'],
      ['Independent verification', 'After writing, OMNIA re-reads the files through a separate code path and checks every voxel against the source. For DICOM → NIfTI, every uncompressed DICOM image is located in the NIfTI and compared value by value.'],
      ['dcm2niix as the reference', 'DICOM → NIfTI uses dcm2niix (Chris Rorden, BSD licence) compiled to WebAssembly, the same program behind the main BIDS converters.'],
      ['De-identification', 'DICOM PS3.15 basic profile, with a consistent pseudonym per patient across the batch, new UIDs and options for dates and patient characteristics. The pseudonym map stays in your folder only.'],
      ['Face removal', 'For head CT, a plane tangent to the intracranial volume (4 mm margin) removes eyes, nose, mouth and chin. The brain lies on the other side of the plane by construction. Always check the frontal rendering.'],
      ['Your data stays on your computer', 'Everything runs in the browser (Web Worker and WebAssembly). The page security policy blocks uploads to any server; only the access email is sent.'],
      ['Known limits', 'RGB and complex data are not converted to DICOM. Mosaics (Siemens, United Imaging) are converted by dcm2niix without OMNIA’s voxel-by-voxel check. Face removal is available for CT only. For research and teaching, not for diagnosis.'],
    ],
  },
};
