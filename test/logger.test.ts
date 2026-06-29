import { afterEach, describe, expect, it, vi } from 'vitest';
import { debugEnabled, logger } from '../src/logger.js';

const ORIG = process.env['NAGI_DEBUG'];
afterEach(() => {
  if (ORIG === undefined) delete process.env['NAGI_DEBUG'];
  else process.env['NAGI_DEBUG'] = ORIG;
  vi.restoreAllMocks();
});

describe('debugEnabled', () => {
  it('is off by default and for empty/0/false', () => {
    delete process.env['NAGI_DEBUG'];
    expect(debugEnabled()).toBe(false);
    for (const v of ['', '0', 'false', 'FALSE']) {
      process.env['NAGI_DEBUG'] = v;
      expect(debugEnabled()).toBe(false);
    }
  });
  it('is on for any other value', () => {
    for (const v of ['1', 'true', 'yes', 'debug']) {
      process.env['NAGI_DEBUG'] = v;
      expect(debugEnabled()).toBe(true);
    }
  });
});

describe('logger.debug', () => {
  it('writes only when NAGI_DEBUG is enabled', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    delete process.env['NAGI_DEBUG'];
    logger.debug('hidden');
    expect(spy).not.toHaveBeenCalled();
    process.env['NAGI_DEBUG'] = '1';
    logger.debug('shown', { a: 1 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain('[nagi:debug] shown');
  });
});
