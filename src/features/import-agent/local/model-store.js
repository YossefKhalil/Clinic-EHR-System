// Model store: load model bytes from (in order) IndexedDB file handles,
// Cache Storage, or a LAN URL. Verify SHA-256 once and cache the result.
//
// Performance:
//  - Downloads stream into Cache Storage; no 2× memory Blob accumulation.
//  - SHA-256 is chunked via hash-wasm; no 686 MB ArrayBuffer copy.
//  - File handles are preferred so wllama can mmap.

import { createSHA256 } from 'hash-wasm';

const DB_NAME = 'clinic-local-models';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';
const STORE_META = 'meta';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveFileHandle(key, handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadFileHandle(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readonly');
    const r = tx.objectStore(STORE_HANDLES).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function clearFileHandle(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function pickFile(accept = '') {
  if (!window.showOpenFilePicker) return null;
  const [handle] = await window.showOpenFilePicker({ types: accept ? [{ accept }] : undefined, multiple: false });
  return handle || null;
}

export async function fileFromHandle(handle) {
  if (!handle) return null;
  try {
    const perm = await handle.queryPermission({ mode: 'read' });
    if (perm !== 'granted') {
      const r = await handle.requestPermission({ mode: 'read' });
      if (r !== 'granted') return null;
    }
    return await handle.getFile();
  } catch {
    return null;
  }
}

// Chunked SHA-256: memory stays flat even for a 700 MB file.
export async function sha256OfFile(file) {
  const hasher = await createSHA256();
  hasher.init();
  const reader = file.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
  }
  return hasher.digest('hex').toUpperCase();
}

export async function verifySha256(file, expected) {
  if (!expected) return true;
  // The stamp keeps the cache honest when a file is replaced by one with the
  // same name and the same size.
  const metaKey = 'sha256:' + file.name + ':' + file.size + ':' + (file.lastModified ?? 0);
  let cached = null;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_META, 'readonly');
    const r = tx.objectStore(STORE_META).get(metaKey);
    cached = await new Promise((res) => { r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
  } catch { cached = null; }
  if (cached === expected.toUpperCase()) return true;
  const actual = await sha256OfFile(file);
  const ok = actual === expected.toUpperCase();
  if (ok) {
    try {
      const db = await openDb();
      const tx = db.transaction(STORE_META, 'readwrite');
      tx.objectStore(STORE_META).put(actual, metaKey);
    } catch { /* ignore */ }
  }
  return ok;
}

const CACHE_NAME = 'clinic-models-v1';

export async function cacheMatch(url) {
  if (!('caches' in window)) return null;
  const cache = await caches.open(CACHE_NAME);
  return cache.match(url);
}

export async function cachePut(url, response) {
  if (!('caches' in window)) return;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(url, response.clone());
}

// Stream a response into Cache Storage while reporting progress. No full-file
// accumulation in JS memory; the browser writes to disk as bytes arrive.
export async function fetchModel(url, onProgress) {
  const cached = await cacheMatch(url);
  if (cached) {
    onProgress && onProgress(1, 1);
    return cached;
  }
  const res = await fetch(url, { priority: 'low' });
  if (!res.ok) throw new Error('fetch failed: ' + res.status);
  const total = Number(res.headers.get('content-length') || 0);

  if (!res.body || !('caches' in window)) {
    const blob = await res.blob();
    onProgress && onProgress(1, 1);
    return new Response(blob);
  }

  let received = 0;
  const progress = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (onProgress) onProgress(received, total || received);
      controller.enqueue(chunk);
    },
  });
  const streamed = res.body.pipeThrough(progress);
  const cache = await caches.open(CACHE_NAME);
  // The original headers describe the untransformed body, so the length and
  // the encoding must not be carried over.
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  // cache.put consumes the stream; afterwards match returns the stored bytes.
  await cache.put(url, new Response(streamed, { headers }));
  const stored = await cache.match(url);
  if (!stored) throw new Error('cache write failed');
  return stored;
}

export async function getModelBlob(fileSpec, onProgress) {
  const handle = await loadFileHandle(fileSpec.name);
  if (handle) {
    const file = await fileFromHandle(handle);
    if (file) {
      const ok = await verifySha256(file, fileSpec.sha256);
      if (ok) {
        onProgress && onProgress(file.size, file.size);
        return file;
      }
    }
  }
  const cached = await cacheMatch(fileSpec.url);
  if (cached) {
    const blob = await cached.blob();
    onProgress && onProgress(blob.size, blob.size);
    return blob;
  }
  const res = await fetchModel(fileSpec.url, onProgress);
  const blob = await res.blob();
  if (fileSpec.sha256) {
    const f = new File([blob], fileSpec.name, { type: 'application/octet-stream' });
    const ok = await verifySha256(f, fileSpec.sha256);
    if (!ok) throw new Error('SHA-256 mismatch for ' + fileSpec.name);
  }
  return blob;
}
