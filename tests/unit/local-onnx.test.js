// The ONNX graph reader.
//
// The reader is checked against a graph this test builds itself, so the
// expectations do not depend on a 450 MB model file being present.

import { describe, it, expect } from 'vitest';
import {
    parseOnnxGraph,
    matchesFalconOcrShape,
    OnnxError,
} from '../../src/features/import-agent/local/onnx-metadata.js';

/** A protobuf writer: varints, length-delimited fields. */
class Proto {
    constructor() {
        this.bytes = [];
    }

    varint(value) {
        let rest = value;
        do {
            let byte = rest & 0x7f;
            rest = Math.floor(rest / 128);
            if (rest > 0) byte |= 0x80;
            this.bytes.push(byte);
        } while (rest > 0);
        return this;
    }

    tag(field, wire) {
        return this.varint((field << 3) | wire);
    }

    bytesField(field, payload) {
        this.tag(field, 2);
        this.varint(payload.length);
        for (const byte of payload) this.bytes.push(byte);
        return this;
    }

    varintField(field, value) {
        this.tag(field, 0);
        this.varint(value);
        return this;
    }

    stringField(field, text) {
        return this.bytesField(field, new TextEncoder().encode(text));
    }

    result() {
        return new Uint8Array(this.bytes);
    }
}

function valueInfo(name, elemType, dims) {
    const dimension = new Proto();
    for (const dim of dims) dimension.varintField(1, dim);
    const shape = new Proto();
    shape.bytesField(1, dimension.result());
    const tensor = new Proto();
    tensor.varintField(1, elemType);
    tensor.bytesField(2, shape.result());
    const type = new Proto();
    type.bytesField(1, tensor.result());
    const info = new Proto();
    info.stringField(1, name);
    info.bytesField(2, type.result());
    return info.result();
}

function buildGraph({ inputs, outputs, opsets = [{ domain: '', version: 17 }] } = {}) {
    const graph = new Proto();
    for (const input of inputs) graph.bytesField(11, input);
    for (const output of outputs) graph.bytesField(12, output);
    const model = new Proto();
    model.varintField(1, 8); // ir_version
    for (const opset of opsets) {
        const entry = new Proto();
        if (opset.domain) entry.stringField(1, opset.domain);
        entry.varintField(2, opset.version);
        model.bytesField(8, entry.result());
    }
    model.bytesField(7, graph.result());
    return model.result();
}

const FALCON_INPUTS = [
    valueInfo('tokens', 7, [1, 512]),
    valueInfo('image_patches', 1, [1, 256, 768]),
    valueInfo('pos_t', 7, [1, 512]),
    valueInfo('pos_hw', 1, [1, 512, 2]),
    valueInfo('attention_mask', 9, [1, 512, 512]),
    valueInfo('past_key_values', 1, [22, 2, 1, 16, 0, 64]),
];
const FALCON_OUTPUTS = [
    valueInfo('next_token', 7, [1]),
    valueInfo('present_key_values', 1, [22, 2, 1, 16, 512, 64]),
];

describe('parseOnnxGraph', () => {
    it('reads the graph inputs and outputs', () => {
        const bytes = buildGraph({ inputs: FALCON_INPUTS, outputs: FALCON_OUTPUTS });
        const graph = parseOnnxGraph(bytes);
        expect(graph.inputs.map((input) => input.name)).toEqual([
            'tokens', 'image_patches', 'pos_t', 'pos_hw', 'attention_mask', 'past_key_values',
        ]);
        expect(graph.outputs.map((output) => output.name)).toEqual(['next_token', 'present_key_values']);
        expect(graph.inputs[0].dtype).toBe('int64');
        expect(graph.inputs[1].dtype).toBe('float32');
        expect(graph.inputs[1].dims).toEqual([1, 256, 768]);
        expect(graph.opsets).toEqual([{ domain: '', version: 17 }]);
        expect(graph.irVersion).toBe(8);
    });

    it('refuses a file without a graph', () => {
        const model = new Proto();
        model.varintField(1, 8);
        expect(() => parseOnnxGraph(model.result())).toThrow(OnnxError);
    });
});

describe('matchesFalconOcrShape', () => {
    it('accepts the Falcon graph and refuses another one', () => {
        const falcon = parseOnnxGraph(buildGraph({ inputs: FALCON_INPUTS, outputs: FALCON_OUTPUTS }));
        expect(matchesFalconOcrShape(falcon)).toBe(true);

        const other = parseOnnxGraph(buildGraph({
            inputs: [valueInfo('input_ids', 7, [1, 8])],
            outputs: [valueInfo('logits', 1, [1, 32000])],
        }));
        expect(matchesFalconOcrShape(other)).toBe(false);
    });
});
