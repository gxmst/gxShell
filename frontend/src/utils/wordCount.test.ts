import { describe, expect, it } from 'vitest';
import { countWords } from './wordCount';

describe('countWords', () => {
  it('counts space-separated words', () => {
    expect(countWords('the quick brown fox')).toBe(4);
  });

  it('collapses runs of whitespace and newlines', () => {
    expect(countWords('one   two\n\nthree\t four ')).toBe(4);
  });

  it('is zero for empty and whitespace-only text', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('   \n\t ')).toBe(0);
  });

  // A split(/\s+/) would report a whole Chinese paragraph as one word, so each
  // ideograph counts individually.
  it('counts each CJK ideograph as a word', () => {
    expect(countWords('你好世界')).toBe(4);
  });

  it('counts mixed CJK and Latin text', () => {
    // 保 + 存 + 到 as three words, plus "changes" and "disk".
    expect(countWords('保存 changes 到 disk')).toBe(5);
  });

  it('handles CJK butted directly against Latin', () => {
    // 服 + 务 + 器, plus "host" — no space needed to separate them.
    expect(countWords('服务器host')).toBe(4);
  });
});
