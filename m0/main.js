import { Wllama } from '@wllama/wllama/esm/index.js';
import { Wllama as WllamaNb } from './wllama-js/index.js';
import mainWasmUrl from '@wllama/wllama/esm/wasm/wllama.wasm?url';
import compatWasmUrl from '@wllama/wllama-compat/wasm/wllama.wasm?url';
import compatWorkerCode from '@wllama/wllama-compat/wasm/wllama.js?raw';
import customWasmUrl from './custom/wllama.wasm?url';
import customWorkerCode from './custom/wllama.js?raw';
import relaxedWasmUrl from './custom-relaxed/wllama.wasm?url';
import relaxedWorkerCode from './custom-relaxed/wllama.js?raw';
import jspiRelaxedWasmUrl from './custom-jspi-relaxed/wllama.wasm?url';
import jspiRelaxedWorkerCode from './custom-jspi-relaxed/wllama.js?raw';
import nbWasmUrl from './custom-jspi-relaxed-nb/wllama.wasm?url';
import nbWorkerCode from './custom-jspi-relaxed-nb/wllama.js?raw';
import { createSHA256 } from 'hash-wasm';
import { probeCapabilities } from './probe.js';
import { DEV_URLS, MODEL_MANIFEST } from './model-manifest.js';

const $ = (id) => document.getElementById(id);

// M0-only experiment: wllama decides between the Memory64 main build and the
// wasm32 compat build via needCompat(), which returns false on Chromium. To
// measure the wasm32 build on Chromium we optionally hide memory64 support from
// the page before wllama inspects it. This never ships; it only affects this
// spike page when ?forcecompat=1 is present.
const FORCE_COMPAT = new URLSearchParams(location.search).get('forcecompat') === '1';
const USE_CUSTOM = new URLSearchParams(location.search).get('custom') === '1';
const USE_RELAXED = new URLSearchParams(location.search).get('relaxed') === '1';
const USE_JSPI = new URLSearchParams(location.search).get('jspi') === '1';
const USE_NB = new URLSearchParams(location.search).get('nb') === '1';
if (FORCE_COMPAT || USE_CUSTOM || USE_RELAXED || USE_JSPI || USE_NB) {
  try {
    const RealMemory = WebAssembly.Memory;
    const patched = function Memory(descriptor) {
      if (descriptor && descriptor.address === 'i64') {
        throw new TypeError('memory64 disabled by M0 forcecompat');
      }
      return new RealMemory(descriptor);
    };
    patched.prototype = RealMemory.prototype;
    Object.defineProperty(WebAssembly, 'Memory', { value: patched, writable: true, configurable: true });
  } catch (error) {
    console.warn('forcecompat: could not patch WebAssembly.Memory', error);
  }
}

const TEXT_SYSTEM = [
  'You extract de-identified clinic records.',
  'Return only YAML with a top-level key `rows` and a list of records.',
  'Each record may contain name, phone, age, diagnosis, visit_date and _src.',
  'Use only values present in the input. Never invent a value. Do not explain.',
].join(' ');

const VISION_PROMPT = [
  'Read this clinic document image.',
  'Return only YAML with a top-level key `rows` and a list of records.',
  'Each record may contain name, phone, age, diagnosis and visit_date.',
  'Use only values visible in the image. If a value is unreadable, omit it.',
  'Do not explain.',
].join(' ');

const SAMPLE_NOTES = [
  'Patient: Mona Adel\nPhone: 01012345678\nAge: 34\nDiagnosis: hypertension\nVisit: 2026-11-02\nFollow-up: 2026-12-01',
  'Patient: Youssef Samir\nPhone: 01198765432\nAge: 51\nDiagnosis: type 2 diabetes\nVisit: 2026-11-03\nFollow-up: 2026-12-08',
  'Patient: Salma Hassan\nPhone: 01234567890\nAge: 27\nDiagnosis: migraine\nVisit: 2026-11-04\nFollow-up: 2026-12-02',
  'Patient: Karim Nabil\nPhone: 01055556666\nAge: 42\nDiagnosis: lower back pain\nVisit: 2026-11-05\nFollow-up: 2026-11-19',
  'Patient: Nourhan Adel\nPhone: 01122223333\nAge: 63\nDiagnosis: osteoarthritis\nVisit: 2026-11-06\nFollow-up: 2026-12-04',
  'Patient: Omar Tarek\nPhone: 01277778888\nAge: 19\nDiagnosis: acute sinusitis\nVisit: 2026-11-07\nFollow-up: 2026-11-21',
];

let wllama = null;
let activeController = null;
let activeKind = null;
let selectedImage = null;
let loadStartedAt = 0;

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function bytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function ms(value) {
  if (!Number.isFinite(value)) return '—';
  return `${(value / 1000).toFixed(2)} s`;
}

function rate(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(2)} tok/s`;
}

function log(message, level = 'info') {
  const line = `[${new Date().toLocaleTimeString()}] ${level.toUpperCase()} ${message}`;
  const panel = $('log');
  panel.textContent += `${line}\n`;
  panel.scrollTop = panel.scrollHeight;
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

function status(id, message, tone = '') {
  $(id).innerHTML = `<span class="dot ${tone}"></span>${esc(message)}`;
}

function metric(label, value) {
  return `<div class="metric"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function setLoadedControls(loaded) {
  $('run-text').disabled = !loaded || Boolean(activeController);
  $('run-vision').disabled = !loaded || Boolean(activeController);
  $('unload').disabled = !loaded;
}

function updateModelSource() {
  const url = $('source').value === 'url';
  $('url-source').style.display = url ? '' : 'none';
  $('disk-source').style.display = url ? 'none' : '';
}

function updateFileInfo() {
  const model = $('model-file').files?.[0] ?? null;
  const projector = $('mmproj-file').files?.[0] ?? null;
  $('model-file-info').textContent = model
    ? `${model.name} — ${bytes(model.size)}${model.size === MODEL_MANIFEST.model.bytes ? '' : ' (expected ' + bytes(MODEL_MANIFEST.model.bytes) + ')'}`
    : 'No file selected.';
  $('mmproj-file-info').textContent = projector
    ? `${projector.name} — ${bytes(projector.size)}${projector.size === MODEL_MANIFEST.projector.bytes ? '' : ' (expected ' + bytes(MODEL_MANIFEST.projector.bytes) + ')'}`
    : 'No file selected.';
  $('hash-status').textContent = '';
}

async function renderCapabilities() {
  $('cap-table').innerHTML = '<tbody><tr><td>Probing…</td></tr></tbody>';
  $('guard-table').innerHTML = '<tbody><tr><td>Probing…</td></tr></tbody>';
  try {
    const caps = await probeCapabilities();
    const rows = [
      ['Secure context', caps.secureContext],
      ['Cross-origin isolated', caps.crossOriginIsolated],
      ['SharedArrayBuffer', caps.sharedArrayBuffer],
      ['Module worker', caps.moduleWorker],
      ['OPFS', caps.opfs.supported],
      ['Wasm SIMD', caps.wasm.simd],
      ['Wasm relaxed SIMD', caps.wasm.relaxedSimd],
      ['Wasm threads', caps.wasm.threads],
      ['Wasm bulk memory', caps.wasm.bulkMemory],
      ['Wasm exceptions', caps.wasm.exceptions],
      ['Wasm memory64', caps.wasm.memory64],
      ['JSPI', caps.jspi],
      ['Logical CPUs', caps.hardwareConcurrency],
      ['Device memory (GB)', caps.deviceMemory],
      ['Storage quota', caps.storage.supported ? bytes(caps.storage.quota) : 'unavailable'],
      ['Storage persisted', caps.storage.supported ? String(caps.storage.persisted) : 'unavailable'],
      ['User agent', caps.userAgent],
    ];
    $('cap-table').innerHTML = `<tbody>${rows
      .map(([name, value]) => {
        const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : (value ?? '—');
        const cls = typeof value === 'boolean' ? (value ? 'ok' : 'no') : '';
        return `<tr><th>${esc(name)}</th><td class="value ${cls}">${esc(text)}</td></tr>`;
      })
      .join('')}</tbody>`;

    const guard = caps.relaxedDotGuard;
    const guardRows = [
      ['Module instantiated', guard.supported],
      ['Result', guard.supported ? guard.result : guard.error],
      ['Signed ARM (-4)', guard.supported ? guard.signedArm : false],
      ['Unsigned x64 (1020)', guard.supported ? guard.unsignedX64 : false],
      ['Relaxed build allowed', guard.supported && guard.signedArm],
    ];
    $('guard-table').innerHTML = `<tbody>${guardRows
      .map(([name, value]) => {
        const text = typeof value === 'boolean' ? (value ? 'yes' : 'no') : (value ?? '—');
        const cls = typeof value === 'boolean' ? (value ? 'ok' : 'no') : '';
        return `<tr><th>${esc(name)}</th><td class="value ${cls}">${esc(text)}</td></tr>`;
      })
      .join('')}</tbody>`;
    log(
      `Capabilities: SIMD=${caps.wasm.simd}, relaxed=${caps.wasm.relaxedSimd}, threads=${caps.wasm.threads}, COI=${caps.crossOriginIsolated}, guard=${guard.supported ? guard.result : 'n/a'}`,
    );
  } catch (error) {
    $('cap-table').innerHTML = `<tbody><tr><td class="no">Probe failed: ${esc(error)}</td></tr></tbody>`;
    log(`Capability probe failed: ${error}`, 'error');
  }
}

function readNumber(id, fallback) {
  const value = Number($(id).value);
  return Number.isFinite(value) ? value : fallback;
}

function readLoadParams() {
  const kv = $('kv').value;
  return {
    n_ctx: readNumber('ctx', 4096),
    n_batch: readNumber('batch', 256),
    n_ubatch: readNumber('ubatch', 256),
    n_threads: Math.max(1, Math.round(readNumber('threads', 4))),
    n_threads_batch: Math.max(1, Math.round(readNumber('threads-batch', 4))),
    n_gpu_layers: 0,
    n_parallel: 1,
    kv_unified: true,
    cache_type_k: kv,
    cache_type_v: kv,
    flash_attn: $('flash').checked,
    jinja: $('jinja').checked,
    reasoning: false,
    warmup: $('warmup').checked,
    seed: 42,
    image_min_tokens: readNumber('img-min', 256),
    image_max_tokens: readNumber('img-max', 1024),
    // Keep the projector and KV cache on CPU as well; this spike must not
    // silently pick a GPU backend.
    mmproj_offload: false,
    no_kv_offload: true,
    offload_kqv: false,
    log_level: 3,
  };
}

function createWllama(compatAssets = null) {
  const WllamaClass = USE_NB ? WllamaNb : Wllama;
  const w = new WllamaClass(
    { default: mainWasmUrl },
    { suppressNativeLog: true, allowOffline: true },
  );
  const mode = FORCE_COMPAT || USE_CUSTOM || USE_RELAXED || USE_JSPI || USE_NB ? 'force' : $('compat').value;
  if (mode === 'off') {
    w.setCompat(null);
  } else {
    w.setCompat(
      compatAssets ?? { wasm: compatWasmUrl, worker: { code: compatWorkerCode } },
      mode === 'force' ? 'firefox_safari' : 'safari',
    );
  }
  return w;
}

async function unloadModel() {
  if (activeController) activeController.abort();
  const current = wllama;
  wllama = null;
  setLoadedControls(false);
  $('load-info').innerHTML = '';
  if (current) {
    try {
      await current.exit();
      log('Model unloaded.');
    } catch (error) {
      log(`Unload failed: ${error}`, 'warn');
    }
  }
  status('load-status', 'No model loaded.');
}

async function loadModel() {
  if (activeController) {
    log('Cannot load while a generation is running.', 'warn');
    return;
  }
  if (wllama) await unloadModel();

  const source = $('source').value;
  const modelFile = $('model-file').files?.[0] ?? null;
  const projectorFile = $('mmproj-file').files?.[0] ?? null;
  if (source === 'disk' && !modelFile) {
    status('load-status', 'Choose the model GGUF first.', 'bad');
    return;
  }

  const params = readLoadParams();
  let compatAssets = null;
  if (USE_NB) {
    compatAssets = { wasm: nbWasmUrl, worker: { code: nbWorkerCode } };
    log('Using custom wasm32 + JSPI + relaxed + n_threads_batch build from m0/custom-jspi-relaxed-nb.');
  } else if (USE_JSPI) {
    compatAssets = { wasm: jspiRelaxedWasmUrl, worker: { code: jspiRelaxedWorkerCode } };
    log('Using custom wasm32 + JSPI + relaxed build from m0/custom-jspi-relaxed.');
  } else if (USE_CUSTOM || USE_RELAXED) {
    const customWasm = USE_RELAXED ? relaxedWasmUrl : customWasmUrl;
    const customWorker = USE_RELAXED ? relaxedWorkerCode : customWorkerCode;
    compatAssets = { wasm: customWasm, worker: { code: customWorker } };
    log(`Using custom wasm32 build from m0/${USE_RELAXED ? 'custom-relaxed' : 'custom'}.`);
  }
  const w = createWllama(compatAssets);
  $('load').disabled = true;
  $('unload').disabled = true;
  $('run-text').disabled = true;
  $('run-vision').disabled = true;
  status('load-status', 'Loading model…');
  loadStartedAt = performance.now();

  try {
    if (source === 'url') {
      log(`Loading from dev server: ${DEV_URLS.model}`);
      await w.loadModelFromUrl(
        { url: DEV_URLS.model, mmprojUrl: DEV_URLS.projector },
        {
          ...params,
          progressCallback: ({ loaded, total }) => {
            const pct = total > 0 ? ((loaded / total) * 100).toFixed(1) : '?';
            status('load-status', `Downloading/caching model… ${pct}% (${bytes(loaded)} / ${bytes(total)})`);
          },
        },
      );
    } else {
      const blobs = [modelFile];
      if (projectorFile) blobs.push(projectorFile);
      log(`Loading from disk: ${modelFile.name}${projectorFile ? ` + ${projectorFile.name}` : ' (text only)'}`);
      await w.loadModel(blobs, params);
    }

    wllama = w;
    const elapsed = performance.now() - loadStartedAt;
    const info = w.getLoadedContextInfo();
    const meta = w.getModelMetadata();
    const imageOk = w.supportInputModality('image');
    status('load-status', `Ready — ${w.isMultithread() ? 'threads' : 'single thread'}${imageOk ? ', vision' : ', text only'}`, 'good');
    $('load-info').innerHTML = `
      <div class="metric-grid">
        ${metric('Load time', ms(elapsed))}
        ${metric('libllama build', Wllama.getLibllamaVersion())}
        ${metric('Threads requested / used', `${params.n_threads} / ${w.getNumThreads()}`)}
        ${metric('Multithread', w.isMultithread() ? 'yes' : 'no')}
        ${metric('n_ctx / n_ctx_train', `${info.n_ctx} / ${info.n_ctx_train}`)}
        ${metric('n_batch / n_ubatch', `${info.n_batch} / ${info.n_ubatch}`)}
        ${metric('n_layer / n_embd', `${info.n_layer} / ${info.n_embd}`)}
        ${metric('Image input', imageOk ? 'yes' : 'no')}
        ${metric('Chat template', info.has_chat ? 'yes' : 'no')}
        ${metric('KV cache', `${params.cache_type_k} / ${params.cache_type_v}`)}
        ${metric('Flash attention', params.flash_attn ? 'on' : 'off')}
        ${metric('Model', meta.meta['general.name'] ?? MODEL_MANIFEST.model.file)}
        ${metric('Architecture', meta.meta['general.architecture'] ?? 'unknown')}
      </div>
      <details><summary>Model metadata</summary><pre class="output">${esc(JSON.stringify(meta, null, 2))}</pre></details>
    `;
    log(
      `Loaded in ${ms(elapsed)}: threads=${w.getNumThreads()} (${w.isMultithread() ? 'MT' : 'ST'}), image=${imageOk}, ctx=${info.n_ctx}, build=${Wllama.getLibllamaVersion()}`,
    );
    setLoadedControls(true);
  } catch (error) {
    wllama = null;
    try {
      await w.exit();
    } catch {
      // The failed instance is already unusable.
    }
    status('load-status', `Load failed: ${error?.type ?? error?.name ?? 'error'} — ${error?.message ?? error}`, 'bad');
    log(`Load failed: ${error?.stack ?? error}`, 'error');
    setLoadedControls(false);
  } finally {
    $('load').disabled = false;
  }
}

async function hashFile(file, onProgress) {
  const hasher = await createSHA256();
  hasher.init();
  const slice = 64 * 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += slice) {
    const end = Math.min(offset + slice, file.size);
    const buffer = await file.slice(offset, end).arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    onProgress(end, file.size);
  }
  return hasher.digest('hex');
}

async function verifyHashes() {
  const model = $('model-file').files?.[0] ?? null;
  const projector = $('mmproj-file').files?.[0] ?? null;
  if (!model) {
    status('hash-status', 'Choose a model file first.', 'bad');
    return;
  }
  $('verify-hash').disabled = true;
  try {
    const checks = [
      { label: 'model', file: model, expected: MODEL_MANIFEST.model },
      ...(projector ? [{ label: 'projector', file: projector, expected: MODEL_MANIFEST.projector }] : []),
    ];
    const messages = [];
    for (const check of checks) {
      if (check.file.size !== check.expected.bytes) {
        messages.push(`${check.label}: size ${bytes(check.file.size)} != ${bytes(check.expected.bytes)}`);
        continue;
      }
      status('hash-status', `Hashing ${check.label}…`);
      const digest = await hashFile(check.file, (done, total) => {
        status('hash-status', `Hashing ${check.label}… ${((done / total) * 100).toFixed(1)}%`);
      });
      const match = digest.toLowerCase() === check.expected.sha256.toLowerCase();
      messages.push(`${check.label}: ${match ? 'SHA-256 match' : `SHA-256 mismatch (${digest})`}`);
      if (!match) {
        log(`${check.label} SHA-256 mismatch: expected ${check.expected.sha256}, got ${digest}`, 'error');
      }
    }
    const ok = messages.every((line) => line.includes('match') && !line.includes('mismatch'));
    status('hash-status', messages.join(' · '), ok ? 'good' : 'bad');
    log(messages.join(' · '), ok ? 'info' : 'error');
  } catch (error) {
    status('hash-status', `Hash failed: ${error}`, 'bad');
    log(`Hash failed: ${error}`, 'error');
  } finally {
    $('verify-hash').disabled = false;
  }
}

function frameTextPrompt() {
  return [
    'Extract every patient record from the text below.',
    'Return YAML only, with a top-level `rows` list.',
    '',
    ...SAMPLE_NOTES.flatMap((note, index) => [`--- note ${index + 1} ---`, note]),
    '--- end ---',
  ].join('\n');
}

function drawSyntheticDocument() {
  const canvas = $('preview');
  const ctx = canvas.getContext('2d');
  canvas.width = 1000;
  canvas.height = 700;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 30px Georgia, serif';
  ctx.fillText('CITY CLINIC — NEW PATIENT RECORD', 48, 62);
  ctx.font = '20px Georgia, serif';
  const lines = [
    'Name: Mona Adel',
    'National ID: 29001011234567',
    'Phone: 01012345678',
    'Date of birth: 1990-01-01',
    'Diagnosis: hypertension',
    'Visit date: 2026-11-02',
    'Follow-up: 2026-12-01',
    '',
    'Name: Youssef Samir',
    'Phone: 01198765432',
    'Age: 51',
    'Diagnosis: type 2 diabetes',
    'Visit date: 2026-11-03',
  ];
  lines.forEach((line, index) => ctx.fillText(line, 64, 118 + index * 38));
  ctx.strokeStyle = '#777777';
  ctx.lineWidth = 2;
  ctx.strokeRect(30, 30, 940, 640);
}

function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob failed'))), type, quality);
  });
}

async function prepareImage(blob, name) {
  const bitmap = await createImageBitmap(blob);
  const longSide = Math.max(bitmap.width, bitmap.height);
  const scale = Math.min(1, 1024 / longSide);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = $('preview');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const jpeg = await canvasToBlob(canvas);
  const buffer = await jpeg.arrayBuffer();
  selectedImage = { blob: jpeg, buffer, width, height, name };
  $('image-info').textContent = `${name} — ${width}×${height}, ${bytes(buffer.byteLength)} JPEG (downscaled to ≤1024 px)`;
  status('vision-status', 'Image ready.');
  log(`Image prepared: ${name}, ${width}×${height}, ${bytes(buffer.byteLength)}`);
}

async function setLocalImage() {
  const file = $('image-file').files?.[0] ?? null;
  if (!file) return;
  try {
    await prepareImage(file, file.name);
  } catch (error) {
    status('vision-status', `Image decode failed: ${error}`, 'bad');
    log(`Image decode failed: ${error}`, 'error');
  }
}

async function useSyntheticImage() {
  try {
    drawSyntheticDocument();
    const blob = await canvasToBlob($('preview'));
    await prepareImage(blob, 'synthetic-clinic-document.jpg');
  } catch (error) {
    status('vision-status', `Synthetic image failed: ${error}`, 'bad');
    log(`Synthetic image failed: ${error}`, 'error');
  }
}

function samplingParams(extra = {}) {
  return {
    temp: readNumber('text-temp', 0.1),
    top_k: readNumber('text-topk', 50),
    top_p: 1.0,
    min_p: 0.0,
    penalty_repeat: readNumber('text-repeat', 1.1),
    seed: 42,
    ...extra,
  };
}

function beginRun(kind) {
  if (!wllama) return null;
  if (activeController) {
    log('Another generation is already running.', 'warn');
    return null;
  }
  const controller = new AbortController();
  activeController = controller;
  activeKind = kind;
  setLoadedControls(true);
  $('run-text').disabled = true;
  $('run-vision').disabled = true;
  $('cancel-text').disabled = kind !== 'text';
  $('cancel-vision').disabled = kind !== 'vision';
  return controller;
}

function endRun() {
  activeController = null;
  activeKind = null;
  $('cancel-text').disabled = true;
  $('cancel-vision').disabled = true;
  setLoadedControls(Boolean(wllama));
}

function describeError(error) {
  if (error?.name === 'AbortError' || /abort/i.test(String(error?.message ?? error))) return 'Cancelled.';
  const type = error?.type ? `${error.type}: ` : '';
  return `${type}${error?.message ?? error}`;
}

async function runText() {
  const controller = beginRun('text');
  if (!controller) return;
  const output = $('text-output');
  output.textContent = '';
  $('text-metrics').innerHTML = '';
  status('text-status', 'Generating…');
  const started = performance.now();
  let firstTokenAt = null;
  let text = '';
  let timings = null;
  let usage = null;
  const maxTokens = readNumber('text-max', 128);

  try {
    const stream = await wllama.createChatCompletion({
      messages: [
        { role: 'system', content: TEXT_SYSTEM },
        { role: 'user', content: $('text-prompt').value },
      ],
      stream: true,
      abortSignal: controller.signal,
      max_tokens: maxTokens,
      ...samplingParams(),
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        text += delta;
        output.textContent = text;
        output.scrollTop = output.scrollHeight;
      }
      if (chunk.timings) timings = chunk.timings;
      if (chunk.usage) usage = chunk.usage;
    }
    const total = performance.now() - started;
    const first = firstTokenAt === null ? NaN : firstTokenAt - started;
    const prefill = timings?.prompt_per_second ?? (usage && first ? usage.prompt_tokens / (first / 1000) : NaN);
    const decode = timings?.predicted_per_second
      ?? (usage && first && total > first ? usage.completion_tokens / ((total - first) / 1000) : NaN);
    $('text-metrics').innerHTML = [
      metric('First token', ms(first)),
      metric('Total', ms(total)),
      metric('Prefill', rate(prefill)),
      metric('Decode', rate(decode)),
      metric('Prompt tokens', usage?.prompt_tokens ?? timings?.prompt_n ?? '—'),
      metric('Completion tokens', usage?.completion_tokens ?? timings?.predicted_n ?? '—'),
      metric('Max tokens', maxTokens),
      metric('Threads', wllama.getNumThreads()),
    ].join('');
    status('text-status', `Done — ${text.length} chars.`, 'good');
    log(`Text done: first=${ms(first)}, total=${ms(total)}, prefill=${rate(prefill)}, decode=${rate(decode)}`);
  } catch (error) {
    const message = describeError(error);
    status('text-status', message, message === 'Cancelled.' ? 'warn' : 'bad');
    log(`Text generation failed: ${error?.stack ?? error}`, message === 'Cancelled.' ? 'warn' : 'error');
  } finally {
    endRun();
  }
}

async function runVision() {
  if (!selectedImage) {
    status('vision-status', 'Choose an image or generate the synthetic document first.', 'bad');
    return;
  }
  if (!wllama.supportInputModality('image')) {
    status('vision-status', 'The loaded model reports no image input. Load the mmproj projector.', 'bad');
    return;
  }
  const controller = beginRun('vision');
  if (!controller) return;
  const output = $('vision-output');
  output.textContent = '';
  $('vision-metrics').innerHTML = '';
  status('vision-status', 'Encoding image and generating…');
  const started = performance.now();
  let firstTokenAt = null;
  let text = '';
  let timings = null;
  let usage = null;
  const maxTokens = 192;

  try {
    const stream = await wllama.createChatCompletion({
      messages: [
        { role: 'system', content: TEXT_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'image', data: selectedImage.buffer },
            { type: 'text', text: VISION_PROMPT },
          ],
        },
      ],
      stream: true,
      abortSignal: controller.signal,
      max_tokens: maxTokens,
      ...samplingParams(),
    });
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (firstTokenAt === null) firstTokenAt = performance.now();
        text += delta;
        output.textContent = text;
        output.scrollTop = output.scrollHeight;
      }
      if (chunk.timings) timings = chunk.timings;
      if (chunk.usage) usage = chunk.usage;
    }
    const total = performance.now() - started;
    const first = firstTokenAt === null ? NaN : firstTokenAt - started;
    const prefill = timings?.prompt_per_second ?? (usage && first ? usage.prompt_tokens / (first / 1000) : NaN);
    const decode = timings?.predicted_per_second
      ?? (usage && first && total > first ? usage.completion_tokens / ((total - first) / 1000) : NaN);
    $('vision-metrics').innerHTML = [
      metric('Image', `${selectedImage.width}×${selectedImage.height}`),
      metric('First token', ms(first)),
      metric('Total', ms(total)),
      metric('Vision prefill', rate(prefill)),
      metric('Decode', rate(decode)),
      metric('Prompt tokens', usage?.prompt_tokens ?? timings?.prompt_n ?? '—'),
      metric('Completion tokens', usage?.completion_tokens ?? timings?.predicted_n ?? '—'),
      metric('Max tokens', maxTokens),
      metric('Threads', wllama.getNumThreads()),
    ].join('');
    status('vision-status', `Done — ${text.length} chars.`, 'good');
    log(`Vision done: first=${ms(first)}, total=${ms(total)}, prefill=${rate(prefill)}, decode=${rate(decode)}`);
  } catch (error) {
    const message = describeError(error);
    status('vision-status', message, message === 'Cancelled.' ? 'warn' : 'bad');
    log(`Vision generation failed: ${error?.stack ?? error}`, message === 'Cancelled.' ? 'warn' : 'error');
  } finally {
    endRun();
  }
}

function cancelActive() {
  if (activeController) {
    activeController.abort();
    log(`Cancel requested for ${activeKind}.`, 'warn');
  }
}

function wireEvents() {
  $('reprobe').addEventListener('click', renderCapabilities);
  $('source').addEventListener('change', updateModelSource);
  $('model-file').addEventListener('change', updateFileInfo);
  $('mmproj-file').addEventListener('change', updateFileInfo);
  $('verify-hash').addEventListener('click', verifyHashes);
  $('load').addEventListener('click', loadModel);
  $('unload').addEventListener('click', unloadModel);
  $('run-text').addEventListener('click', runText);
  $('run-vision').addEventListener('click', runVision);
  $('cancel-text').addEventListener('click', cancelActive);
  $('cancel-vision').addEventListener('click', cancelActive);
  $('image-file').addEventListener('change', setLocalImage);
  $('synthetic').addEventListener('click', useSyntheticImage);
  $('clear-log').addEventListener('click', () => {
    $('log').textContent = '';
  });
  window.addEventListener('error', (event) => log(`Window error: ${event.message}`, 'error'));
  window.addEventListener('unhandledrejection', (event) => log(`Unhandled rejection: ${event.reason}`, 'error'));
}

function init() {
  $('url-model').textContent = DEV_URLS.model;
  $('url-mmproj').textContent = DEV_URLS.projector;
  $('text-prompt').value = frameTextPrompt();
  $('threads').value = String(Math.max(1, Math.min(4, navigator.hardwareConcurrency || 4)));
  $('threads-batch').value = $('threads').value;
  wireEvents();
  updateModelSource();
  updateFileInfo();
  setLoadedControls(false);
  log(`M0 harness started. Pinned model: ${MODEL_MANIFEST.repo}@${MODEL_MANIFEST.revision}`);
  log(`Main wasm: ${mainWasmUrl}`);
  log(`Compat wasm: ${compatWasmUrl}`);
  renderCapabilities();
}

init();
