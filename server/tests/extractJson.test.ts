import { describe, expect, it } from 'vitest';
import { extractJson, quoteBareValues } from '../src/agent/callModel.js';

describe('reading a model reply as JSON', () => {
  it('reads plain JSON, a code fence and chatter around the object', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go: {"a": 1} Done.')).toEqual({ a: 1 });
  });

  it('repairs a text value that is missing its opening quote, as the model GLM-5 sometimes writes it', () => {
    const reply = '{\n  "dimensions": [\n    {\n      "id": "G01",\n      "score": 3,\n      "rationale": The artifact lacks a legend, and "quotes" appear.",\n      "not_measurable": false\n    }\n  ]\n}';
    expect(extractJson(reply)).toEqual({ dimensions: [{ id: 'G01', score: 3, rationale: 'The artifact lacks a legend, and "quotes" appear.', not_measurable: false }] });
  });

  it('repairs a bare value on the last line of an object, with or without a closing quote', () => {
    expect(extractJson('{\n  "a": 1,\n  "rationale": Every field is defined\n}')).toEqual({ a: 1, rationale: 'Every field is defined' });
    expect(extractJson('{\n  "a": 1,\n  "rationale": Every field is defined"\n}')).toEqual({ a: 1, rationale: 'Every field is defined' });
  });

  it('leaves valid values alone: numbers, booleans, null, strings, arrays and objects', () => {
    const valid = '{\n  "a": 1,\n  "b": true,\n  "c": null,\n  "d": "text",\n  "e": [1],\n  "f": {"g": 2}\n}';
    expect(quoteBareValues(valid)).toBe(valid);
    expect(extractJson(valid)).toEqual({ a: 1, b: true, c: null, d: 'text', e: [1], f: { g: 2 } });
  });

  it('still refuses a reply that is not JSON at all, or broken in a way it does not repair', () => {
    expect(() => extractJson('no json here')).toThrow(/not a JSON object/);
    expect(() => extractJson('{"a": [1, 2')).toThrow();
    expect(() => extractJson('{"a": 1,, "b": 2}')).toThrow(/not valid JSON/);
  });
});
