// The local provider's error mapping.
//
// llama.cpp aborts inside its Jinja engine when a model's own chat template
// uses a feature the build does not implement, and the abort reaches
// JavaScript as a stack trace. The provider has to turn that into a code the
// wizard can translate, or every chunk shows the generic "provider call
// failed".

import { describe, it, expect } from 'vitest';
import { mapRuntimeError } from '../../src/features/import-agent/local/wllama-provider.js';

describe('mapRuntimeError', () => {
    it('maps a template application failure to MODEL_TEMPLATE_UNSUPPORTED', () => {
        const original = new Error('failed to apply chat template, try using --jinja');
        const mapped = mapRuntimeError(original);
        expect(mapped.code).toBe('MODEL_TEMPLATE_UNSUPPORTED');
        expect(mapped.cause).toBe(original);
    });

    it('maps the wasm abort trace that gemma-4 triggers', () => {
        const abort = new Error(
            '    wasm-func[985] (__wrap_abort)\n    wasm-func[69] (ggml_abort)\n'
            + '    wasm-func[2090] (common_chat_templates_get_caps)\n'
            + '    wasm-func[5808] (oaicompat_chat_params_parse)\n    wasm-func[3390] (wllama_action)',
        );
        expect(mapRuntimeError(abort).code).toBe('MODEL_TEMPLATE_UNSUPPORTED');
    });

    it('leaves an unrelated failure untouched', () => {
        const other = new Error('out of memory');
        expect(mapRuntimeError(other)).toBe(other);
        expect(mapRuntimeError(other).code).toBeUndefined();
    });
});
