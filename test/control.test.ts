import { describe, expect, it } from 'vitest';
import { parseControl } from '../src/dispatcher/control.js';

describe('parseControl', () => {
  it('recognizes status and cancel synonyms', () => {
    expect(parseControl('status')).toBe('status');
    expect(parseControl('STOP')).toBe('cancel');
    expect(parseControl(' abort ')).toBe('cancel');
  });

  it('recognizes done/close as the retirement verb', () => {
    expect(parseControl('done')).toBe('done');
    expect(parseControl('Close')).toBe('done');
  });

  it('returns undefined for ordinary messages', () => {
    expect(parseControl('open a surface')).toBeUndefined();
  });
});
