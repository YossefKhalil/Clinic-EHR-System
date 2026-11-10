// The feature-detect package ships an `import.source(...)` probe that Vite 5's
// esbuild parser cannot read. These are the same tiny validation modules,
// copied locally so the spike does not depend on proposal syntax in a
// dependency.
const WASM_MODULES = Object.freeze({
  simd: [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11],
  relaxedSimd: [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11],
  threads: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11],
  bulkMemory: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11],
  exceptions: [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11],
  memory64: [0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1],
});

function validateModule(name) {
  try {
    return WebAssembly.validate(new Uint8Array(WASM_MODULES[name]));
  } catch {
    return false;
  }
}

function probeThreads() {
  try {
    if (typeof SharedArrayBuffer === 'undefined' || typeof MessageChannel === 'undefined') return false;
    const channel = new MessageChannel();
    channel.port1.postMessage(new SharedArrayBuffer(1));
    channel.port1.close();
    channel.port2.close();
    return validateModule('threads');
  } catch {
    return false;
  }
}

// Minimal one-instruction repro from the llama.cpp relaxed-SIMD review:
// i32x4.relaxed_dot_i8x16_i7x16_add_s(all 1, all -1, 0)
//
// The second operand is outside the 0..127 range in which relaxed SIMD is
// required to be deterministic. ARM sdot returns -4 per lane (signed); V8 on
// x64 returns 1020 per lane (unsigned). A relaxed build is only safe when this
// returns -4. Never choose the build from userAgent.
export function relaxedDotGuard() {
  try {
    const v128 = (byte) => [0xfd, 0x0c, ...Array(16).fill(byte)];
    const body = [
      0x00,
      ...v128(0x01),
      ...v128(0xff),
      ...v128(0x00),
      0xfd,
      0x93,
      0x02,
      0xfd,
      0x1b,
      0x00,
      0x0b,
    ];
    const code = [0x01, body.length, ...body];
    const bytes = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0,
      1, 5, 1, 0x60, 0, 1, 0x7f,
      3, 2, 1, 0,
      7, 5, 1, 1, 0x66, 0, 0,
      10, code.length, ...code,
    ]);
    const { f } = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
    const result = f();
    return {
      supported: true,
      result,
      signedArm: result === -4,
      unsignedX64: result === 1020,
    };
  } catch (error) {
    return { supported: false, error: String(error) };
  }
}

async function probeModuleWorker() {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return false;
  const source = 'self.onmessage = () => self.postMessage("pong");';
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const worker = new Worker(url, { type: 'module' });
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker timeout')), 3000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(event.message || 'worker error'));
      };
      worker.postMessage('ping');
    });
    worker.terminate();
    return reply === 'pong';
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function probeOpfs() {
  if (!navigator.storage?.getDirectory) return { supported: false };
  try {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('m0-probe.txt', { create: true });
    const writable = await handle.createWritable();
    await writable.write('ok');
    await writable.close();
    await root.removeEntry('m0-probe.txt');
    return { supported: true };
  } catch (error) {
    return { supported: false, error: String(error) };
  }
}

async function probeStorage() {
  if (!navigator.storage?.estimate) return { supported: false };
  try {
    const estimate = await navigator.storage.estimate();
    return {
      supported: true,
      usage: estimate.usage ?? null,
      quota: estimate.quota ?? null,
      persisted: navigator.storage.persisted
        ? await navigator.storage.persisted()
        : null,
    };
  } catch (error) {
    return { supported: false, error: String(error) };
  }
}

export async function probeCapabilities() {
  const [
    moduleWorker,
    opfs,
    storage,
  ] = await Promise.all([
    probeModuleWorker(),
    probeOpfs(),
    probeStorage(),
  ]);

  const hasBulkMemory = validateModule('bulkMemory');
  const hasExceptions = validateModule('exceptions');
  const hasMemory64 = validateModule('memory64');
  const hasRelaxedSimd = validateModule('relaxedSimd');
  const hasSimd = validateModule('simd');
  const hasThreads = probeThreads();

  const guard = relaxedDotGuard();

  return {
    userAgent: navigator.userAgent,
    secureContext: globalThis.isSecureContext === true,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemory: navigator.deviceMemory ?? null,
    hasWasm: typeof WebAssembly !== 'undefined',
    wasm: {
      simd: Boolean(hasSimd),
      relaxedSimd: Boolean(hasRelaxedSimd),
      threads: Boolean(hasThreads),
      bulkMemory: Boolean(hasBulkMemory),
      exceptions: Boolean(hasExceptions),
      memory64: Boolean(hasMemory64),
    },
    relaxedDotGuard: guard,
    moduleWorker,
    opfs,
    storage,
    jspi: 'Suspending' in WebAssembly,
  };
}
