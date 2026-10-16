import { sanitizeFilename } from './filename.util';
import { sanitizeHeaderValue } from './header.util';
import { sanitizeMarkdown } from './markdown.util';
import { isPathWithin, sanitizePathSegment } from './path.util';
import { normalizeUnicode, stripInvisibleChars } from './unicode.util';
import { isSsrfSafeUrl, sanitizeUrl } from './url.util';

describe('sanitizeHeaderValue (§13)', () => {
  it('strips CRLF so a header cannot be split', () => {
    expect(sanitizeHeaderValue('a\r\nX-Injected: 1')).toBe('aX-Injected: 1');
    expect(sanitizeHeaderValue('a\u0000b\u2028c\u0085d')).toBe('abcd');
    expect(sanitizeHeaderValue('a\tb')).toBe('a\tb');
  });
});

describe('sanitizePathSegment / isPathWithin (§13)', () => {
  it("sanitizePathSegment('../../etc/passwd') returns a safe single segment", () => {
    const segment = sanitizePathSegment('../../etc/passwd');
    expect(segment).toBe('etc_passwd');
    expect(segment).not.toMatch(/[\\/]|\.\./);
  });
  it('strips null bytes, drive prefixes, backslashes and residual traversal tokens', () => {
    expect(sanitizePathSegment('a\u0000b.txt')).toBe('ab.txt');
    expect(sanitizePathSegment('C:\\Windows\\..\\x')).toBe('Windows_x');
    expect(sanitizePathSegment('a..b')).toBe('a.b');
    expect(sanitizePathSegment('..')).toBe('_');
    expect(sanitizePathSegment('')).toBe('_');
    expect(sanitizePathSegment('.hidden')).toBe('hidden');
  });
  it('isPathWithin is a containment check on the resolved path', () => {
    expect(isPathWithin('/srv/uploads', '/srv/uploads/a/b.txt')).toBe(true);
    expect(isPathWithin('/srv/uploads', 'a/b.txt')).toBe(true);
    expect(isPathWithin('/srv/uploads', '../etc/passwd')).toBe(false);
    expect(isPathWithin('/srv/uploads', '/srv/uploads-evil/x')).toBe(false);
    expect(isPathWithin('/srv/uploads', '/etc/passwd')).toBe(false);
    expect(isPathWithin('/srv/uploads', 'a\u0000.txt')).toBe(false);
  });
});

describe('sanitizeFilename (§13)', () => {
  it('reduces to a safe basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\temp\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFilename('a<b>:c?.txt')).toBe('a_b__c_.txt');
    expect(sanitizeFilename('x.php.')).toBe('x.php');
    expect(sanitizeFilename('...')).toBe('file');
    expect(sanitizeFilename('')).toBe('file');
  });
  it('neutralises Windows device names, leading dots (default) and RTL-override tricks', () => {
    expect(sanitizeFilename('CON.txt')).toBe('_CON.txt');
    expect(sanitizeFilename('nul')).toBe('_nul');
    expect(sanitizeFilename('.htaccess')).toBe('htaccess');
    expect(sanitizeFilename('.htaccess', { stripLeadingDots: false })).toBe('.htaccess');
    expect(sanitizeFilename('evil\u202Egpj.exe')).toBe('evilgpj.exe');
  });
  it('bounds the length while preserving the extension', () => {
    expect(sanitizeFilename(`${'a'.repeat(300)}.pdf`, { maxLength: 20 })).toBe(`${'a'.repeat(16)}.pdf`);
    expect(sanitizeFilename('a'.repeat(400)).length).toBeLessThanOrEqual(255);
    expect(() => sanitizeFilename('a', { maxLength: 0 })).toThrow(RangeError);
  });
  it('enforces an extension allowlist (case-insensitive) with 400', () => {
    expect(sanitizeFilename('r.PDF', { allowedExtensions: ['pdf', '.png'] })).toBe('r.PDF');
    expect(() => sanitizeFilename('r.exe', { allowedExtensions: ['pdf'] })).toThrow('not allowed');
    expect(() => sanitizeFilename('readme', { allowedExtensions: ['pdf'] })).toThrow('not allowed');
  });
});

describe('sanitizeUrl (§13)', () => {
  it('returns the normalised URL for allowed schemes and null otherwise', () => {
    expect(sanitizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('java\tscript:alert(1)')).toBeNull();
    expect(sanitizeUrl('data:text/html,<script>')).toBeNull();
    expect(sanitizeUrl('//evil.com')).toBeNull();
    expect(sanitizeUrl('')).toBeNull();
    expect(sanitizeUrl('http://x.com/' + 'a'.repeat(3000))).toBeNull();
    expect(sanitizeUrl(undefined as never)).toBeNull();
  });
  it('rejects embedded credentials (phishing form)', () => {
    expect(sanitizeUrl('https://trusted.com@evil.com/')).toBeNull();
    expect(sanitizeUrl('https://user:pw@example.com/')).toBeNull();
  });
  it('supports custom protocols and same-origin relative paths only', () => {
    expect(sanitizeUrl('mailto:a@b.co', { allowedProtocols: ['mailto'] })).toBe('mailto:a@b.co');
    expect(sanitizeUrl('/profile/1', { allowRelative: true })).toBe('/profile/1');
    expect(sanitizeUrl('//evil.com', { allowRelative: true })).toBeNull();
    expect(sanitizeUrl('/\\evil.com', { allowRelative: true })).toBeNull();
    expect(sanitizeUrl('/profile/1')).toBeNull();
  });
});

describe('isSsrfSafeUrl (§13)', () => {
  it("isSsrfSafeUrl('http://169.254.169.254/') returns false (cloud metadata)", async () => {
    expect(await isSsrfSafeUrl('http://169.254.169.254/')).toBe(false);
    expect(await isSsrfSafeUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
  });
  it('blocks loopback, private, decimal/hex/octal-encoded and IPv6-wrapped addresses', async () => {
    for (const url of ['http://localhost:8080', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://[::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://10.1.2.3/', 'https://192.168.1.1/', 'http://[fd00:ec2::254]/', 'http://metadata.google.internal/', 'http://a.localhost/']) {
      expect(await isSsrfSafeUrl(url)).toBe(false);
    }
  });
  it('blocks non-http schemes, credentials and garbage; allows public IP literals', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://x', 'http://user:pw@8.8.8.8/', 'not a url', '']) expect(await isSsrfSafeUrl(url)).toBe(false);
    expect(await isSsrfSafeUrl('http://8.8.8.8/')).toBe(true);
    expect(await isSsrfSafeUrl('https://[2606:4700:4700::1111]/')).toBe(true);
  });
});

describe('unicode hygiene (§13)', () => {
  it('stripInvisibleChars removes zero-width, BIDI, BOM and TAG characters but keeps emoji presentation and whitespace', () => {
    expect(stripInvisibleChars('a\u200Bb\u202Ec\uFEFFd')).toBe('abcd');
    expect(stripInvisibleChars(`hi${String.fromCodePoint(0xe0041)}!`)).toBe('hi!');
    expect(stripInvisibleChars('\u2764\uFE0F')).toBe('\u2764\uFE0F');
    expect(stripInvisibleChars('a\tb\nc')).toBe('a\tb\nc');
  });
  it('normalizeUnicode folds full-width forms (NFKC)', () => {
    expect(normalizeUnicode('\uFF1Cscript\uFF1E')).toBe('<script>');
  });
});

describe('sanitizeMarkdown (§13)', () => {
  const md = sanitizeMarkdown;
  it('neutralises raw HTML, comments and active autolinks', () => {
    expect(md('hi <script>alert(1)</script>')).not.toContain('<script');
    expect(md('<img src=x onerror=alert(1)>')).not.toContain('<img');
    expect(md('a <!-- x --> b')).not.toContain('<!--');
    expect(md('<javascript:alert(1)>')).not.toContain('<javascript');
  });
  it('replaces unsafe link/image/reference destinations (including obfuscated ones) with #', () => {
    expect(md('[x](javascript:alert(1))')).toBe('[x](#)');
    expect(md('[x](java\tscript:alert(1))')).toBe('[x](#)');
    expect(md('[x](javascript&colon;alert(1))')).toBe('[x](#)');
    expect(md('![a](data:text/html;base64,AAA)')).toBe('![a](#)');
    expect(md('[a]: javascript:alert(1)')).toBe('[a]: #');
  });
  it('keeps safe links, relative links, safe autolinks, code and ordinary prose untouched', () => {
    expect(md('[x](https://example.com/a_(b)?q=1)')).toBe('[x](https://example.com/a_(b)?q=1)');
    expect(md('[x](/docs/a) [y](#sec) [z](../up)')).toBe('[x](/docs/a) [y](#sec) [z](../up)');
    expect(md('<https://example.com>')).toBe('<https://example.com>');
    expect(md('```html\n<script>x</script>\n```')).toBe('```html\n<script>x</script>\n```');
    expect(md('use `<b>` tag')).toBe('use `<b>` tag');
    expect(md('# Title\n\n- a\n- b\n\n> quote & more')).toBe('# Title\n\n- a\n- b\n\n> quote & more');
  });
  it('strips invisible/BIDI characters', () => {
    expect(md('a\u202Eb')).toBe('ab');
  });
});
