import { describe, expect, it } from 'vitest';
import { documentPresentation, needsLightweightMarkdown, textDocumentHeadings, MAX_DOCUMENT_HEADINGS } from './documentPresentation';
import { supportedTextExtensions, supportedTextFileNames } from './textFiles';

const paragraph = '这是一段普通的说明文字，用来介绍项目的使用方法和注意事项。正文应当自然换行，保持舒适的阅读宽度，同时完整保留文件里的所有文字。';

describe('automatic document presentation', () => {
  it('assigns a presentation to every supported text suffix and deployment filename', () => {
    const expected = {
      markdown: ['.md', '.markdown'], plain: ['.txt', '.text'], log: ['.log'],
      config: ['.conf', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml', '.xml', '.service'],
      data: ['.json', '.jsonc', '.jsonl', '.ndjson'], table: ['.csv', '.tsv'],
    };
    for (const ext of supportedTextExtensions) {
      const kind = Object.entries(expected).find(([, extensions]) => extensions.includes(ext))?.[0] || 'code';
      expect(documentPresentation('/docs/FILE' + ext.toUpperCase(), ''), ext).toBe(kind);
    }
    for (const name of supportedTextFileNames) {
      expect(['code', 'config']).toContain(documentPresentation('/docs/' + name, ''));
    }
    expect(documentPresentation('/docs/.env.production', paragraph)).toBe('config');
    expect(documentPresentation('/docs/Containerfile.prod', paragraph)).toBe('code');
    expect(documentPresentation('/docs/manual.pdf', '')).toBe('pdf');
  });

  it('uses prose only for clear natural-language text, including general documentation', () => {
    expect(documentPresentation('notes.txt', paragraph + '\n\n' + paragraph)).toBe('prose');
    expect(documentPresentation('guide.text', 'Section 1 Getting started\n\n' + 'This document explains how to configure and use the application. Keep the existing settings until you are ready to save your changes.')).toBe('prose');
    for (const text of ['hello\nworld', 'key=value\nanother=value', 'name\tcount\nfirst\t2', 'NAME    STATUS\nworker  running', '{"body":"text"}', '<h1>Title</h1>']) {
      expect(documentPresentation('unknown.txt', text), text).toBe('plain');
    }
    expect(documentPresentation('runtime.txt', '2026-09-15 10:00:00 INFO Ready\n2026-09-15 10:00:01 ERROR Failed')).toBe('log');
    expect(documentPresentation('source.txt', paragraph + '\nconst enabled = true;\n' + paragraph)).toBe('plain');
  });

  it('checks more than the beginning of a long .txt file', () => {
    const text = paragraph.repeat(250) + '\n' + '2026-09-15 10:00:00 INFO Ready\n'.repeat(1000);
    expect(documentPresentation('mixed.txt', text)).toBe('log');
  });

  it('recognizes long single paragraphs even when sample windows cut through sentences', () => {
    expect(documentPresentation('chapter.txt', paragraph.repeat(600))).toBe('prose');
    const english = 'This paragraph explains how the application keeps the current reading position. Continue reading the same paragraph after resizing the window. ';
    expect(documentPresentation('chapter.text', english.repeat(400))).toBe('prose');
    expect(documentPresentation('record.txt', 'unstructured_data_without_sentences'.repeat(1000))).toBe('plain');
  });

  it('extracts real headings with exact source offsets, without treating fenced examples as headings', () => {
    const prose = '第一章 开始\n' + paragraph + '\n\n第二节 方法\n' + paragraph;
    const outline = textDocumentHeadings(prose);
    expect(outline.map((item) => item.text)).toEqual(['第一章 开始', '第二节 方法']);
    expect(outline[1].from).toBe(prose.indexOf('第二节'));
    const markdown = ['# Start', '\x60\x60\x60md', '## Example', '\x60\x60\x60', '## Actual'].join('\n');
    expect(textDocumentHeadings(markdown, true).map((item) => item.text)).toEqual(['Start', 'Actual']);
    expect(textDocumentHeadings('# Item\n'.repeat(10000), true)).toHaveLength(MAX_DOCUMENT_HEADINGS);
  });

  it('bounds rich Markdown by both size and line count', () => {
    expect(needsLightweightMarkdown('# Notes\n\nSmall document.')).toBe(false);
    expect(needsLightweightMarkdown('x'.repeat(1024 * 1024 + 1))).toBe(true);
    expect(needsLightweightMarkdown('item\n'.repeat(12000))).toBe(true);
  });
});
