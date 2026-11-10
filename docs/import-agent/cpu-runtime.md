# CPU-only local AI runtime (M0 evidence)

Status: **M0 spike in progress.** This document records the feasibility evidence for
issue #59: browser-only, CPU-only, offline-capable extraction using
LFM3-VL-2B via wllama/llama.cpp compiled to WASM.

No production UI, job protocol, or model-store code has been enabled yet. The
entry point stays disabled until M0/M1 acceptance checks pass.

## Test machine

- CPU: Intel Core i7-8700 @ 3.20 GHz, 6 cores / 12 logical, 16 GB RAM.
- OS/browser: Windows, OpenCode in-app Chromium 152 (Electron), `crossOriginIsolated=true`.
- Capability probe: WebAssembly SIMD, relaxed SIMD, threads, bulk memory,
  exceptions, memory64, JSPI all true. Relaxed-dot guard returns **1020**
  (x64 unsigned), so the relaxed-SIMD build is rejected on this machine.
- Storage quota observed: ~2.8 GB, not persisted.

## Model (pinned)

- Repo: `LiquidAI/LFM3-VL-2B-GGUF`
- Revision: `1add221a5ea6c047fcf1eaaf2d247939d7cf8849`
- Chat model: `LFM3-VL-2B-QAD-Q4_0.gguf`
  - 1,049,615,648 bytes
  - SHA-256 `621c455376cb96a20891697deb9975c6fb47dd5ea98ed3ad1f3b7e8f24f0b1e6`
- Vision projector: `mmproj-LFM3-VL-2B-Q8_0.gguf`
  - 203,031,872 bytes
  - SHA-256 `c5c5b58d544a18da919172d2d0368090ea1a4a351b6feb7f8a326a264a5918ab`
- Licence: LFM Open License v1.0. The deploying clinic is a charity with no
  revenue, so the USD 10M commercial-use threshold does not apply. Keep
  attribution/NOTICE handling.

## Toolchain

- Emscripten 4.0.20 (emsdk), no Docker.
- wllama source pinned to tag `3.13.0`
  (`6647c1ea3837b2f0205a300c3bf5ff644aaa06bf`); llama.cpp submodule at
  `7d7f0287530bc8981690f361d8c1627dbae1c99a` (reports `b12211-7d7f028`).
- Build script: `m0/build-wllama-wasm.ps1`.
- Custom build config (compat / wasm32 / no WebGPU / no native):
  `-DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm -DWLLAMA_COMPAT=ON -DLLAMA_WASM_MEM64=OFF -DGGML_WEBGPU=OFF -DGGML_NATIVE=OFF -DLLAMA_CURL=OFF`.
- Outputs copied to `m0/custom/`:
  - `wllama.js` 130,598 bytes
  - `wllama.wasm` 15,930,944 bytes
- Build log proof it used the WASM quant path:
  `-- CMAKE_SYSTEM_PROCESSOR: wasm`, `-- Wasm detected`,
  `[14/152] Building C object .../ggml-cpu/arch/wasm/quants.c.o`.

## Root cause: why the stock npm build is slow

Emscripten 4.0.20 defaults `EMSCRIPTEN_SYSTEM_PROCESSOR=x86`, so
`CMAKE_SYSTEM_PROCESSOR=x86`. llama.cpp only compiles its WASM quant kernels
when:

```cmake
elseif (CMAKE_SYSTEM_PROCESSOR MATCHES "wasm")
    list(APPEND GGML_CPU_SOURCES ggml-cpu/arch/wasm/quants.c)
else()
    message(WARNING "Unknown CPU architecture. Falling back to generic implementations.")
    list(APPEND ARCH_FLAGS -DGGML_CPU_GENERIC)
endif()
```

`ggml_get_system_arch()` maps `x86` to `UNKNOWN`, so the wasm branch is skipped
and Q4_0 matmul falls back to generic scalar C. `-msimd128` still vectorizes
some generic loops, but not the hot quantized dot product.

Stock wllama also ships its main build as Memory64/JSPI/WebGPU, which issue #59
forbids, and reserves the wasm32 build for Safari compat only.

## Results (same machine and model)

### Text: controlled short prompt

Prompt `Patient: Mona Adel. Age: 34. Diagnosis: hypertension. Return one YAML row.`;
96 prompt tokens, 16 completion tokens; CPU only (`n_gpu_layers: 0`), context
4096, batch/ubatch 256/256, KV q4_0/q4_0, flash attention on.

| Build | Threads | Prefill t/s | Decode t/s | First token |
|---|---:|---:|---:|---:|
| Stock wllama main (Memory64) | 4 | 3.25 | 2.80 | 29.59 s |
| Stock wllama "compat" (still main on Chromium) | 4 | 3.27 | 2.83 | 29.38 s |
| Custom wasm32 (this work) | 4 | 17.55 | 11.36 | 5.48 s |
| Custom wasm32 | 6 | 24.30 | 14.43 | 3.96 s |
| Custom wasm32 | 8 | 24.74 | 15.11 | 3.89 s |

Longer custom run (413 prompt / 321 completion, 4 threads): prefill 17.36,
decode 11.26 t/s, first token 23.83 s, total 52.26 s, all six rows correct.

### Comparison: native llama.cpp (no browser)

Native build `3b4d6ab`, 4 threads, same model:

| Test | Prefill t/s | Decode t/s |
|---|---:|---:|
| `llama-bench -p 96 -n 16` | 93.14 | 24.56 |
| Six-note extraction | 96.4 | 23.4 |

Native on 6/8/12 threads (issue M0 comment): prefill 111.66/122.44/144.09,
decode 26.17/27.22/27.95.

### Vision

Synthetic clinic document, 1000×700 JPEG, 43.2 KB, downscaled to ≤1024 px,
passed as `ArrayBuffer`.

| Build | Prompt tokens | Prefill t/s | Decode t/s | First token |
|---|---:|---:|---:|---:|
| Stock wllama (CV infographic) | 874 | 3.83 | 4.27 | 228.27 s |
| Custom wasm32, 4 threads | 820 | 12.17 | 10.49 | 67.49 s |

The custom vision run returned the expected clinic rows for the synthetic
document.

## Interpretation

- The custom `-DEMSCRIPTEN_SYSTEM_PROCESSOR=wasm` build is roughly **5.4x faster
  prefill and 4x faster decode** than stock wllama, and roughly **3.4x faster
  vision prefill**.
- It is still slower than native: about 4x on prefill and 1.6x on decode at
  4 threads. Prefill benefits most from the fix, which matches the compute-bound
  nature of prompt processing.
- Threads help: 4 → 6 threads is a large gain; 6 → 8 is marginal. This machine
  is the issue's reference i7-8700, not the low-end target.
- The first viable artifact is the **compat (Asyncify) wasm32** build. It avoids
  Memory64 and works in Chromium when compat is forced. Asyncify costs some
  performance; a non-Asyncify wasm32 path remains an open question.
- Relaxed SIMD is not usable on this x64 machine because the guard returns 1020
  (correct behavior per the issue). The issue's guard policy assumes ARM signed
  semantics; this needs a documented decision before shipping relaxed builds.

## Open items

1. Decide the artifact set: compat-only, or add a non-Asyncify wasm32/JSPI
   build by patching wllama CMake and rebuilding its embedded worker.
2. Resolve relaxed-SIMD guard policy for x64.
3. Test Firefox (in-app browser is Chromium only).
4. Benchmark on a 2-core/4-thread i3 8 GB target; tune thread/context/KV/batch
   defaults and publish before/after.
5. Measure peak memory for a 4096-context text job and a vision job.
6. Decide model/projector storage (OPFS vs IndexedDB vs wllama cache) and
   SHA-256 provenance flow.
7. Publish the pinned custom wasm artifact (self-hosted under `public/` or CI
   artifact) with MIME/cache/CSP/COOP/COEP headers for Cloudflare Pages.
8. Build the local-only job protocol and worker/runtime integration.

## Reproducibility

- M0 harness: `m0/index.html`, `m0/main.js`, `m0/probe.js`, `m0/model-manifest.js`.
- Custom build: `m0/build-wllama-wasm.ps1` (requires emsdk 4.0.20, CMake, Ninja).
- Native baseline: `E:\GY-Labs\llama-cpp-new\build\bin\Release\` build `3b4d6ab`.
- Evaluation prompts: `m0/eval/system.txt`, `m0/eval/notes.txt`.

## Final M0 update: JSPI, `n_threads_batch`, and the 2-thread target

The final artifact is **wasm32 + JSPI + relaxed SIMD + corrected Q4_0 kernel +
`n_threads_batch`**, built from the pinned wllama 3.13 source. The matching
wllama JS bundle must be rebuilt too: adding the C++ field without rebuilding
`esm/index.js` makes the first load abort because the stock JS never sends
`n_threads_batch`.

Controlled prompt: 96 prompt tokens / 16 completion tokens, same model and
settings (ctx 4096, KV q4_0, flash attention on, CPU only).

| Build / threads / batch | Prefill t/s | Decode t/s | First token |
|---|---:|---:|---:|
| JSPI + relaxed, 2 / 2, 128/128 | 10.97 | 6.61 | 8.77 s |
| JSPI + relaxed + nb, 2 / 4, 128/128 | 20.89 | 6.89 | 4.60 s |
| JSPI + relaxed + nb, 2 / 4, 256/256 | **21.19** | **6.89** | **4.53 s** |
| JSPI + relaxed + nb, 2 / 12, 256/256 | 29.94 | 6.83 | 3.23 s |
| JSPI + relaxed + nb, 12 / 12, 128/128 | 33.09 | 17.32 | 2.90 s |
| Native llama.cpp AVX2, 2 threads | **54.10** | **19.73** | — |

Interpretation for the low-end target:

- On a 2-core/4-thread machine, the best realistic split is **2 decode threads
  / 4 batch threads**. This nearly doubles prefill over 2/2 (10.97 -> 21.19)
  while decode stays the same (6.89 t/s).
- Native 2-thread is still about **2.55x faster on prefill** and **2.86x faster
  on decode** than the browser 2/4 configuration. The remaining gap is WASM
  SIMD width and codegen versus AVX2, not another fixable wllama bug.
- JSPI and Asyncify are effectively identical in raw speed at 4/8/12 threads;
  JSPI wins on artifact size (7.64 MB wasm vs 15.93 MB) and future browser
  compatibility.
- Relaxed SIMD on this x64 machine bypasses the old `-4` guard for the M0
  experiment. Before shipping, validate the corrected Q4_0 kernel against the
  standard build on the fixture set and document the x64 guard policy.
- Recommended defaults for the 2C/4T i3: `n_threads=2`,
  `n_threads_batch=4`, `n_batch=256`, `n_ubatch=256`, ctx 4096, KV q4_0,
  flash attention on.
