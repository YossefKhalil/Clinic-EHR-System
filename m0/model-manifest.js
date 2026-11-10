// Pinned model identity for the M0 feasibility spike.
//
// The numbers below come from the Hugging Face repository metadata at the
// revision recorded here, and were checked against the local files on the
// workstation used for the spike. Do not replace them with "latest".
export const MODEL_MANIFEST = Object.freeze({
  repo: 'LiquidAI/LFM3-VL-2B-GGUF',
  revision: '1add221a5ea6c047fcf1eaaf2d247939d7cf8849',
  licence: 'LFM Open License v1.0',
  model: Object.freeze({
    file: 'LFM3-VL-2B-QAD-Q4_0.gguf',
    bytes: 1_049_615_648,
    sha256: '621c455376cb96a20891697deb9975c6fb47dd5ea98ed3ad1f3b7e8f24f0b1e6',
  }),
  projector: Object.freeze({
    file: 'mmproj-LFM3-VL-2B-Q8_0.gguf',
    bytes: 203_031_872,
    sha256: 'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab',
  }),
});

export const HF_BASE = `https://huggingface.co/${MODEL_MANIFEST.repo}/resolve/${MODEL_MANIFEST.revision}`;

export const HF_URLS = Object.freeze({
  model: `${HF_BASE}/${MODEL_MANIFEST.model.file}`,
  projector: `${HF_BASE}/${MODEL_MANIFEST.projector.file}`,
});

// The dev-only Vite middleware serves this folder. On this workstation
// models/lfm3 is a junction to E:\GY-Labs\OpenWeights, so the 1.25 GB model
// never has to be copied into the repo.
export const DEV_URLS = Object.freeze({
  model: `/models/lfm3/${MODEL_MANIFEST.model.file}`,
  projector: `/models/lfm3/${MODEL_MANIFEST.projector.file}`,
});
