import { sanitizeHtml } from './html.util';

describe("sanitizeHtml (§13) — requires an explicit profile", () => {
  it("'strict' strips <script> (and its content) and every other tag", () => {
    const out = sanitizeHtml('<p>Hello <b>world</b><script>alert(1)</script></p>', 'strict');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).not.toContain('<');
    expect(out).toContain('Hello');
    expect(out).toContain('world');
  });
  it("'strict' drops <style> content and event-handler attributes, and escapes stray markup", () => {
    expect(sanitizeHtml('<style>body{display:none}</style>x', 'strict')).toBe('x');
    expect(sanitizeHtml('<img src=x onerror=alert(1)>t', 'strict')).toBe('t');
    expect(sanitizeHtml('1 < 2 & 3 > 2', 'strict')).toBe('1 &lt; 2 &amp; 3 &gt; 2');
  });
  it("'basic-formatting' preserves <b> while still stripping <script>", () => {
    const out = sanitizeHtml('<b>bold</b><i>it</i><script>alert(1)</script>', 'basic-formatting');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<i>it</i>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('alert');
  });
  it("'basic-formatting' keeps http(s)/mailto links, forces rel, and removes javascript:/data:/protocol-relative hrefs", () => {
    const ok = sanitizeHtml('<a href="https://example.com" rel="author" target="_blank" onclick="x()">x</a>', 'basic-formatting');
    expect(ok).toContain('href="https://example.com"');
    expect(ok).toContain('rel="noopener noreferrer nofollow"');
    expect(ok).not.toContain('target');
    expect(ok).not.toContain('onclick');
    expect(ok).not.toContain('author');
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>', 'basic-formatting')).not.toContain('javascript');
    expect(sanitizeHtml('<a href="data:text/html,x">x</a>', 'basic-formatting')).not.toContain('data:');
    expect(sanitizeHtml('<a href="//evil.com">x</a>', 'basic-formatting')).not.toContain('evil.com');
    expect(sanitizeHtml('<a href="mailto:a@b.co">m</a>', 'basic-formatting')).toContain('mailto:a@b.co');
  });
  it("'basic-formatting' removes images, styles, classes and ids", () => {
    const out = sanitizeHtml('<p class="c" id="i" style="x:y">t<img src="https://e.com/a.png"></p>', 'basic-formatting');
    expect(out).toBe('<p>t</p>');
  });
  it('defeats nested/obfuscated script tags', () => {
    expect(sanitizeHtml('<scr<script>ipt>alert(1)</scr</script>ipt>', 'strict')).not.toContain('<script');
    expect(sanitizeHtml('<SCRIPT SRC=//evil.com/x.js></SCRIPT>', 'basic-formatting')).not.toContain('evil.com');
  });
  it('REQUIRES a valid profile (anti-pattern #7: no implicit default)', () => {
    expect(() => sanitizeHtml('x', undefined as never)).toThrow(TypeError);
    expect(() => sanitizeHtml('x', 'permissive' as never)).toThrow(TypeError);
  });
  it('returns an empty string for a non-string input', () => {
    expect(sanitizeHtml(undefined as never, 'strict')).toBe('');
  });
});
