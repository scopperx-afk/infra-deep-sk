import { createSafeXmlParser } from './xml-parser.util';

describe('createSafeXmlParser (§14) — XXE / entity expansion', () => {
  const parser = createSafeXmlParser();
  it('parses an ordinary document', () => {
    expect(parser.parse('<root><a>1</a><b>two</b></root>')).toEqual({ root: { a: 1, b: 'two' } });
  });
  it('the XXE parser rejects a <!ENTITY> declaration (and any DOCTYPE/DTD)', () => {
    expect(() => parser.parse('<!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r>&x;</r>')).toThrow('not allowed');
    expect(() => parser.parse('<!ENTITY a "b"><r/>')).toThrow('not allowed');
    expect(() => parser.parse('<!doctype r><r/>')).toThrow('not allowed');
    expect(() => parser.parse('<! DOCTYPE r><r/>')).toThrow('not allowed');
  });
  it('rejects a billion-laughs payload before any expansion happens', () => {
    const bomb = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><l>&b;&b;&b;</l>';
    expect(() => parser.parse(bomb)).toThrow('not allowed');
  });
  it('does not expand entities in content and bounds the input size', () => {
    expect(JSON.stringify(parser.parse('<r>&lt;x&gt;</r>'))).not.toContain('<x>');
    expect(() => createSafeXmlParser({ maxInputChars: 10 }).parse('<r>' + 'x'.repeat(50) + '</r>')).toThrow('too large');
  });
  it('accepts a Buffer', () => {
    expect(parser.parse(Buffer.from('<r><a>1</a></r>'))).toEqual({ r: { a: 1 } });
  });
});
