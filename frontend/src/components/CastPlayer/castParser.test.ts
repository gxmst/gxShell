import { describe, expect, it } from 'vitest';
import { parseCast } from './castParser';

describe('parseCast', () => {
  it('parses CRLF recordings and shows the first output immediately', () => {
    const parsed = parseCast([
      '{"version":2,"width":99,"height":30,"title":"demo"}',
      '[1.5,"r","120x40"]',
      '[2.9,"o","hello"]',
      '[3.4,"o"," world"]',
    ].join('\r\n'));

    expect(parsed.header).toEqual({ width: 99, height: 30, title: 'demo' });
    expect(parsed.events).toEqual([
      { time: 0, code: 'r', data: '120x40' },
      { time: 0, code: 'o', data: 'hello' },
      { time: 0.5, code: 'o', data: ' world' },
    ]);
  });

  it('keeps valid output from a truncated recording', () => {
    const parsed = parseCast('{"version":2}\n[1,"o","ok"]\n[broken');
    expect(parsed.events).toEqual([{ time: 0, code: 'o', data: 'ok' }]);
  });
});
