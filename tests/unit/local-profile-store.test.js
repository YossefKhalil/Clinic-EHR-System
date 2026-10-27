// The model profile store and the verification state machine.
//
// The profile is the bridge between the settings card (which picks files) and
// the import run (which loads them). It has to survive a reload, keep a handle
// when a settings save rebuilds the draft from the server, and never report
// "Ready" for a file that was not probed.

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
    emptyProfile,
    saveProfile,
    loadProfile,
    deleteProfile,
    getAllProfiles,
    clearProfile,
    updateVerificationStatus,
    canTransition,
    normalizeStatus,
    verifyModel,
    repairProfile,
    profileNeedsRepair,
    loadFileBlob,
    PROFILE_STATUSES,
} from '../../src/features/import-agent/local/model-profile.js';

class Writer {
    constructor() {
        this.bytes = [];
    }

    u8(value) { this.bytes.push(value & 0xff); return this; }
    u32(value) {
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
        return this;
    }
    u64(value) {
        let rest = value;
        for (let i = 0; i < 8; i += 1) { this.bytes.push(rest & 0xff); rest = Math.floor(rest / 256); }
        return this;
    }
    str(text) {
        const encoded = new TextEncoder().encode(text);
        this.u64(encoded.length);
        for (const byte of encoded) this.bytes.push(byte);
        return this;
    }
    result() { return new Uint8Array(this.bytes); }
}

/** A minimal GGUF the probe accepts: llama architecture, no template. */
function ggufBytes({ architecture = 'llama' } = {}) {
    const writer = new Writer();
    writer.u32(0x46554747);
    writer.u32(3);
    writer.u64(0); // tensors
    writer.u64(1); // key/value pairs
    writer.str('general.architecture');
    writer.u32(8); // string
    writer.str(architecture);
    return writer.result();
}

function fileOf(bytes, name = 'model.gguf', lastModified = 1) {
    return new File([bytes], name, { lastModified });
}

function handleOf(file) {
    // A `File` is structured-cloneable, so it survives the IndexedDB round
    // trip in a test the way a real FileSystemFileHandle survives a reload.
    //
    // Note: a clone does not keep `File.name` on every runtime (Node 22's
    // structuredClone returns a plain Blob), which is exactly why the store
    // persists `name` on the record instead of reading it back from the
    // handle. Tests therefore assert the record's `name` and the handle's
    // bytes, never `handle.name`.
    return file;
}

function profileWith(slot, file) {
    const profile = emptyProfile();
    profile.mode = 'split';
    profile[slot] = {
        handle: handleOf(file),
        name: file.name,
        kind: 'gguf',
        size: file.size,
        sha256: '',
    };
    return profile;
}

beforeEach(async () => {
    await clearProfile();
});

describe('per-slot storage', () => {
    it('saves and loads one profile slot', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        const saved = await saveProfile('text', {
            handle: handleOf(file),
            name: file.name,
            size: file.size,
            mode: 'split',
            config: { text: { contextTokens: 4096 } },
        });

        expect(saved.id).toBe('text');
        expect(saved.status).toBe(PROFILE_STATUSES.NOT_VERIFIED);
        expect(saved.sha256).toBe('');
        expect(saved.config.text.contextTokens).toBe(4096);

        const loaded = await loadProfile('text');
        expect(loaded.name).toBe('text.gguf');
        expect(loaded.mode).toBe('split');
        expect(loaded.handle).toBeTruthy();
        expect(await loaded.handle.arrayBuffer()).toEqual(await file.arrayBuffer());
    });

    it('returns null for a slot that was never stored', async () => {
        expect(await loadProfile('vision')).toBe(null);
    });

    it('lists every configured slot in a stable order', async () => {
        await saveProfile('support', { name: 'falcon', files: {} });
        await saveProfile('vision', { name: 'vision.onnx', mode: 'split' });
        await saveProfile('text', { name: 'text.gguf', mode: 'split' });

        const all = await getAllProfiles();
        expect(all.map((entry) => entry.id)).toEqual(['text', 'vision', 'support']);
    });

    it('deletes one slot without touching the others', async () => {
        await saveProfile('text', { name: 'text.gguf' });
        await saveProfile('vision', { name: 'vision.onnx' });

        expect(await deleteProfile('text')).toBe(true);
        expect(await loadProfile('text')).toBe(null);
        expect((await loadProfile('vision')).name).toBe('vision.onnx');
        expect(await deleteProfile('text')).toBe(false);
    });
});

describe('stored Files (Firefox and Safari)', () => {
    it('saves and restores a File for a slot without a handle', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', {
            file,
            name: file.name,
            size: file.size,
            kind: 'gguf',
            mode: 'split',
        });

        const loaded = await loadProfile('text');
        expect(loaded.handle).toBe(null);
        expect(loaded.file).toBeTruthy();
        expect(loaded.file.name).toBe('text.gguf');
        expect(new Uint8Array(await loaded.file.arrayBuffer()))
            .toEqual(new Uint8Array(await file.arrayBuffer()));
        expect(profileNeedsRepair(loaded)).toBe(false);
    });

    it('carries the stored File into the composite profile', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        const profile = emptyProfile();
        profile.mode = 'split';
        profile.text = { file, name: file.name, size: file.size, kind: 'gguf' };
        await saveProfile(profile);

        const loaded = await loadProfile();
        expect(loaded.text.file).toBeTruthy();
        expect(loaded.text.handle).toBeFalsy();
        expect(loaded.text.name).toBe('text.gguf');
    });

    it('deletes the stored bytes with the slot', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { file, name: file.name, size: file.size });
        expect(await loadFileBlob('text')).toBeTruthy();

        await deleteProfile('text');
        expect(await loadFileBlob('text')).toBe(null);
        expect(await loadProfile('text')).toBe(null);
    });

    it('clears the stored bytes with the whole profile', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { file, name: file.name, size: file.size });
        await clearProfile();

        expect(await loadFileBlob('text')).toBe(null);
    });
});

describe('the composite profile', () => {
    it('still saves the shape the runner reads', async () => {
        const profile = profileWith('text', fileOf(ggufBytes(), 'text.gguf'));
        await saveProfile(profile);

        const loaded = await loadProfile();
        expect(loaded.mode).toBe('split');
        expect(loaded.text.name).toBe('text.gguf');
        expect(new Uint8Array(await loaded.text.handle.arrayBuffer()))
            .toEqual(new Uint8Array(await profile.text.handle.arrayBuffer()));
        expect(loaded.text.handle.size).toBe(profile.text.size);
    });

    it('writes the slot records as well, so both views agree', async () => {
        const profile = profileWith('text', fileOf(ggufBytes(), 'text.gguf'));
        await saveProfile(profile);

        const slot = await loadProfile('text');
        expect(slot.name).toBe('text.gguf');
        expect(slot.status).toBe(PROFILE_STATUSES.NOT_VERIFIED);
    });

    it('keeps a stored handle when a settings save has no handle for the same file', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        const first = profileWith('text', file);
        await saveProfile(first);

        // A save after a reload: the draft came from the server, which never
        // has handles, and therefore carries `handle: null`.
        const second = emptyProfile();
        second.mode = 'split';
        second.text = { handle: null, name: file.name, kind: 'gguf', size: file.size, sha256: '' };
        await saveProfile(second);

        const loaded = await loadProfile();
        expect(loaded.text.handle).toBeTruthy();
        expect(loaded.text.name).toBe(file.name);
        expect(await loaded.text.handle.arrayBuffer()).toEqual(await file.arrayBuffer());
        expect((await loadProfile('text')).handle).toBeTruthy();
    });

    it('does not carry a handle across a different file name', async () => {
        await saveProfile(profileWith('text', fileOf(ggufBytes(), 'old.gguf')));
        const next = emptyProfile();
        next.mode = 'split';
        next.text = { handle: null, name: 'new.gguf', kind: 'gguf', size: 4, sha256: '' };
        await saveProfile(next);
        expect((await loadProfile()).text.handle).toBe(null);
    });

    it('stores the optional projector beside the single model', async () => {
        const model = fileOf(ggufBytes(), 'model.gguf');
        const projector = fileOf(ggufBytes({ architecture: 'clip' }), 'mmproj-model-f16.gguf');
        const profile = emptyProfile();
        profile.mode = 'single';
        profile.multimodal = { handle: handleOf(model), name: model.name, size: model.size, kind: 'gguf' };
        profile.mmproj = { handle: handleOf(projector), name: projector.name, size: projector.size, kind: 'gguf' };
        await saveProfile(profile);

        const loaded = await loadProfile();
        expect(loaded.multimodal.name).toBe('model.gguf');
        expect(loaded.mmproj.name).toBe('mmproj-model-f16.gguf');
        expect(loaded.mmproj.handle).toBeTruthy();
        expect((await loadProfile('mmproj')).name).toBe('mmproj-model-f16.gguf');
    });
});

describe('the verification state machine', () => {
    it('knows the legal transitions', () => {
        expect(canTransition('not_configured', 'not_verified')).toBe(true);
        expect(canTransition('not_verified', 'ready')).toBe(true);
        expect(canTransition('not_verified', 'error')).toBe(true);
        expect(canTransition('ready', 'not_verified')).toBe(true);
        expect(canTransition('error', 'not_verified')).toBe(true);
        expect(canTransition('not_configured', 'ready')).toBe(false);
        expect(canTransition('ready', 'configured')).toBe(false);
    });

    it('maps the old UI words', () => {
        expect(normalizeStatus('ok')).toBe('ready');
        expect(normalizeStatus('warn')).toBe('not_verified');
        expect(normalizeStatus('none')).toBe('not_configured');
        expect(normalizeStatus('nonsense')).toBe(null);
    });

    it('moves a slot through not_verified, ready and error', async () => {
        await saveProfile('text', { name: 'text.gguf' });

        const ready = await updateVerificationStatus('text', 'ready');
        expect(ready.status).toBe('ready');
        expect(ready.verifiedAt).toBeTypeOf('number');
        expect(ready.errorCode).toBeUndefined();

        const failed = await updateVerificationStatus('text', 'error', 'GGUF_ARCH_UNSUPPORTED');
        expect(failed.status).toBe('error');
        expect(failed.errorCode).toBe('GGUF_ARCH_UNSUPPORTED');
        expect(failed.verifiedAt).toBeUndefined();

        const retry = await updateVerificationStatus('text', 'not_verified');
        expect(retry.status).toBe('not_verified');
    });

    it('refuses a jump the machine does not allow', async () => {
        await saveProfile('text', {});
        await expect(updateVerificationStatus('text', 'ready')).rejects.toMatchObject({
            code: 'INVALID_STATUS_TRANSITION',
        });
    });

    it('refuses an unknown status and an unknown slot', async () => {
        await saveProfile('text', { name: 'text.gguf' });
        await expect(updateVerificationStatus('text', 'almost')).rejects.toMatchObject({ code: 'INVALID_STATUS' });
        await expect(updateVerificationStatus('vision', 'ready')).rejects.toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    });
});

describe('verifyModel', () => {
    it('runs probe and hash, calls the smoke render, and reports ready', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { handle: handleOf(file), name: file.name, size: file.size, mode: 'split' });

        let smokeCalls = 0;
        const result = await verifyModel('text', {
            smokeRender: async () => { smokeCalls += 1; return { skipped: false, text: 'OK' }; },
        });

        expect(result.ok).toBe(true);
        expect(result.status).toBe('ready');
        expect(result.sha256).toMatch(/^[0-9A-F]{64}$/);
        expect(result.probe.capabilities.architecture).toBe('llama');
        expect(smokeCalls).toBe(1);

        const stored = await loadProfile('text');
        expect(stored.status).toBe('ready');
        expect(stored.sha256).toBe(result.sha256);
        expect(stored.verifiedAt).toBeTypeOf('number');
    });

    it('records a probe refusal as error(<code>)', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { handle: handleOf(file), name: file.name, size: file.size });

        const result = await verifyModel('text', {
            probe: async () => ({ ok: false, code: 'GGUF_ARCH_UNSUPPORTED', detail: 'not in this build' }),
            smokeRender: false,
        });

        expect(result.ok).toBe(false);
        expect(result.status).toBe('error');
        expect(result.code).toBe('GGUF_ARCH_UNSUPPORTED');
        expect((await loadProfile('text')).errorCode).toBe('GGUF_ARCH_UNSUPPORTED');
    });

    it('asks for repair when the file cannot be reached during verification', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', {
            handle: file,
            name: file.name,
            size: file.size,
        });
        // The settings card always has a composite profile; the repair path
        // must remove the slot from it as well as from the slot store.
        await saveProfile(profileWith('text', file));

        const result = await verifyModel('text', {
            smokeRender: false,
            computeSHA256: async () => {
                throw Object.assign(new Error('the file is gone'), { code: 'MODEL_FILE_UNAVAILABLE' });
            },
        });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('MODEL_FILE_UNAVAILABLE');
        expect(result.repair).toBe(true);
        expect(profileNeedsRepair(await loadProfile('text'))).toBe(true);

        const repaired = await repairProfile('text');
        expect(repaired.handle).toBe(null);
        expect(repaired.status).toBe(PROFILE_STATUSES.NOT_CONFIGURED);
        // The composite must no longer count the model as configured.
        expect((await loadProfile()).text).toBe(null);
    });

    it('reports a hash mismatch instead of accepting the wrong file', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', {
            handle: handleOf(file),
            name: file.name,
            size: file.size,
            sha256: 'A'.repeat(64),
        });

        const result = await verifyModel('text', { smokeRender: false });
        expect(result.ok).toBe(false);
        expect(result.code).toBe('MODEL_HASH_MISMATCH');
    });

    it('does not verify a slot with no file', async () => {
        await saveProfile('text', { name: 'text.gguf' });
        const result = await verifyModel('text');
        expect(result.ok).toBe(false);
        expect(result.status).toBe('not_configured');
        expect(result.code).toBe('MODEL_FILE_MISSING');
        expect(result.repair).toBe(true);
    });

    it('verifies a support folder from its stored files', async () => {
        const files = {};
        for (const name of ['tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'config.json']) {
            files[name] = new File(['{}'], name, { lastModified: 1 });
        }
        await saveProfile('support', { name: 'falcon', files });
        const result = await verifyModel('support');
        expect(result.ok).toBe(true);
        expect(result.support).toBe(true);
        expect((await loadProfile('support')).status).toBe('ready');
    });

    it('verifies a slot from a stored File without a handle', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { file, name: file.name, size: file.size, mode: 'split' });

        const result = await verifyModel('text', { smokeRender: false });
        expect(result.ok).toBe(true);
        expect((await loadProfile('text')).file).toBeTruthy();
        expect((await loadProfile('text')).handle).toBe(null);
    });

    it('asks a projector slot to probe in the projector role', async () => {
        const file = fileOf(ggufBytes({ architecture: 'clip' }), 'mmproj-model-f16.gguf');
        await saveProfile('mmproj', { file, name: file.name, size: file.size, mode: 'single' });

        let seen = null;
        const result = await verifyModel('mmproj', {
            smokeRender: false,
            probe: async (source, options) => {
                seen = options;
                return { ok: false, error: 'MMPROJ_INVALID', detail: 'not a projector' };
            },
        });

        expect(seen.role).toBe('projector');
        expect(result.ok).toBe(false);
        expect((await loadProfile('mmproj')).errorCode).toBe('MMPROJ_INVALID');
    });

    it('keeps the probe positions and the runtime label on a refusal', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { file, name: file.name, size: file.size });

        const result = await verifyModel('text', {
            smokeRender: false,
            probe: async () => ({
                ok: false,
                error: 'GGUF_TRUNCATED',
                detail: 'the header ends early',
                params: { read: '1.5 KB', total: '2.0 KB' },
                bytesConsumed: 1500,
                fileSize: 2048,
                runtimeLabel: 'wllama 3.8.1',
                warnings: ['cut short'],
            }),
        });

        expect(result.code).toBe('GGUF_TRUNCATED');
        expect(result.params).toEqual({ read: '1.5 KB', total: '2.0 KB' });
        expect(result.bytesConsumed).toBe(1500);
        expect(result.fileSize).toBe(2048);
        expect(result.runtimeLabel).toBe('wllama 3.8.1');
    });

    it('persists an explicitly allowed architecture on the slot', async () => {
        const file = fileOf(ggufBytes(), 'text.gguf');
        await saveProfile('text', { file, name: file.name, size: file.size });

        const result = await verifyModel('text', {
            smokeRender: false,
            probeOptions: { allowUnsupportedArchitecture: true },
            probe: async () => ({
                ok: true,
                adapter: 'gguf-text',
                capabilities: { kind: 'gguf', architecture: 'brand-new', architectureSupported: false },
                warnings: ['the architecture is not on the checked-in support list'],
            }),
        });

        expect(result.ok).toBe(true);
        expect((await loadProfile('text')).allowUnsupportedArchitecture).toBe(true);
    });
});
