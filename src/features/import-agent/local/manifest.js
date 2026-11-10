// The one model the local import engine can run. The revision, byte sizes and
// SHA-256 values are pinned so a file is either exactly this build or refused.
// Nothing here is fetched unless the user explicitly asks to download.

export const MODEL_MANIFEST = Object.freeze({
    id: 'lfm3-vl-2b-qad-q4_0',
    name: 'LFM3-VL-2B',
    title: 'LFM3-VL-2B QAD-Q4_0',
    quant: 'QAD-Q4_0',
    repo: 'LiquidAI/LFM3-VL-2B-GGUF',
    revision: '1add221a5ea6c047fcf1eaaf2d247939d7cf8849',
    license: 'LFM Open License v1.0',
    files: Object.freeze({
        model: Object.freeze({
            name: 'LFM3-VL-2B-QAD-Q4_0.gguf',
            bytes: 1_049_615_648,
            sha256: '621c455376cb96a20891697deb9975c6fb47dd5ea98ed3ad1f3b7e8f24f0b1e6',
        }),
        projector: Object.freeze({
            name: 'mmproj-LFM3-VL-2B-Q8_0.gguf',
            bytes: 203_031_872,
            sha256: 'c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab',
        }),
    }),
});

const HF_BASE = `https://huggingface.co/${MODEL_MANIFEST.repo}/resolve/${MODEL_MANIFEST.revision}`;

export const MODEL_URLS = Object.freeze({
    model: `${HF_BASE}/${MODEL_MANIFEST.files.model.name}`,
    projector: `${HF_BASE}/${MODEL_MANIFEST.files.projector.name}`,
});

export function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}