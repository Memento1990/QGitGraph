import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/protocol';
import { expandEmoji, tokenizeMessage, type MessageToken } from '../src/lib/message';

const settings = { ...DEFAULT_SETTINGS, markdown: true, issueUrl: 'https://issues.example/{id}' };
function content(tokens: MessageToken[]): string { return tokens.map(token => 'text' in token ? token.text : content(token.children)).join(''); }
function links(tokens: MessageToken[]): { url: string; text: string }[] { return tokens.flatMap(token => token.kind === 'link' ? [{ url: token.url, text: content(token.children) }] : 'children' in token ? links(token.children) : []); }

describe('safe local commit message tokens', () => {
  it('supports inline bold, italic, bolditalic and code while preserving HTML as text', () => {
    const tokens = tokenizeMessage('**bold** *italic* ***both*** `:bug: #123 https://example.com` <img src=x onerror=alert(1)>', settings);
    expect(tokens.some(token => token.kind === 'bold')).toBe(true); expect(tokens.some(token => token.kind === 'italic')).toBe(true); expect(tokens.some(token => token.kind === 'bolditalic')).toBe(true);
    expect(tokens.find(token => token.kind === 'code')).toEqual({ kind: 'code', text: ':bug: #123 https://example.com' });
    expect(links(tokens)).toEqual([]); expect(content(tokens)).toContain('<img src=x onerror=alert(1)>');
  });
  it('leaves Markdown literal when disabled but still safely links URLs and configured issues', () => {
    const tokens = tokenizeMessage('**literal** `code` #42 https://example.com/path', { ...settings, markdown: false });
    expect(tokens.some(token => ['bold', 'italic', 'code'].includes(token.kind))).toBe(false);
    expect(content(tokens)).toBe('**literal** `code` #42 https://example.com/path');
    expect(links(tokens).map(link => link.url)).toEqual(['https://issues.example/42', 'https://example.com/path']);
  });
  it('expands common gitmoji and custom Unicode locally, leaving unknown tokens unchanged', () => {
    expect(expandEmoji(':sparkles: :bug: :recycle: :construction_worker: :safety_vest: :money_with_wings:')).toBe('✨ 🐛 ♻️ 👷 🦺 💸');
    const custom = { shipit: '🚢', bug: '✓', review: '<not HTML>' };
    expect(expandEmoji(':shipit: :bug: :unknown_code: :review:', custom)).toBe('🚢 ✓ :unknown_code: <not HTML>');
    expect(content(tokenizeMessage(':bug: `:bug:`', { ...settings, customEmoji: custom }))).toBe('✓ :bug:');
    expect(content(tokenizeMessage(':bug:', { ...settings, emoji: false }))).toBe(':bug:');
  });
  it('handles safe Markdown links and trims punctuation on automatic HTTP/HTTPS links', () => {
    const tokens = tokenizeMessage('[**docs**](https://example.com/a?q=1&b=2) (https://example.com/a_(b)). https://example.net/test,', settings);
    expect(links(tokens)).toEqual([
      { text: 'docs', url: 'https://example.com/a?q=1&b=2' },
      { text: 'https://example.com/a_(b)', url: 'https://example.com/a_(b)' },
      { text: 'https://example.net/test', url: 'https://example.net/test' },
    ]);
    expect(content(tokens)).toContain('(https://example.com/a_(b)).');
  });
  it('never produces javascript/data/file/protocol-relative or credential-bearing links', () => {
    const text = '[bad](javascript:alert(1)) [data](data:text/html,hi) [file](file:///C:/bad) [relative](//evil.example) https://user:pass@example.com #12';
    expect(links(tokenizeMessage(text, { ...settings, issueUrl: 'javascript:alert({id})' }))).toEqual([]);
    expect(content(tokenizeMessage(text, { ...settings, issueUrl: '' }))).toBe(text);
  });
  it('applies numeric issue rules in order without ever evaluating untrusted regex', () => {
    const tokens = tokenizeMessage('TEAM-123 #7 TEAM-4x notTEAM-9', { ...settings, issueRules: [
      { pattern: '(a+)+$', url: 'https://bad.example/{id}' },
      { pattern: '\\bTEAM-(\\d+)\\b', url: 'https://team.example/ticket/{id}?ref={match}' },
    ] });
    expect(links(tokens)).toEqual([
      { text: 'TEAM-123', url: 'https://team.example/ticket/123?ref=TEAM-123' }, { text: '#7', url: 'https://issues.example/7' },
    ]);
  });
  it('preserves arbitrary malicious text, unknown emoji and unmatched syntax without dropping content', () => {
    for (const text of ['<script>alert(1)</script>', '**unclosed', '`unclosed', ':unknown_emoji:', 'snake_case_identifier', '\\*not italic\\*']) {
      const expected = text === '\\*not italic\\*' ? '*not italic*' : text;
      expect(content(tokenizeMessage(text, { ...settings, issueUrl: '' }))).toBe(expected);
    }
  });
  it('bounds work and retains untouched tails of very large or marker-heavy messages', () => {
    const text = '*'.repeat(200000) + '\n:unknown_tail: <script>x</script>';
    const tokens = tokenizeMessage(text, settings); expect(tokens.length).toBeLessThanOrEqual(4100); expect(content(tokens)).toContain(':unknown_tail: <script>x</script>');
    const long = 'a'.repeat(200000); expect(content(tokenizeMessage(long, settings, true))).toBe(long);
  });
});
