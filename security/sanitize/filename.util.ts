/**
 * Upload filename sanitiser — Security spec §13.
 *
 * Reduces an attacker-supplied name to a safe BASENAME: no directory components, no
 * control/reserved characters, no Windows device names (CON, NUL, COM1…), no trailing
 * dots/spaces (Windows strips them, which turns `x.php.` into `x.php`), optional
 * leading-dot stripping (default on: no `.htaccess`/`.env` uploads), length-bounded with
 * the extension preserved.
 *
 * `allowedExtensions` is an ALLOWLIST check, not a transform — a disallowed extension
 * cannot be "sanitised" into a safe one, so it throws 400. Extension is trusted for NOTHING
 * beyond this check: content type must still be verified by magic bytes (Storage §8) and
 * double extensions (`a.php.jpg`) are a server-configuration concern, not solved by a name.
 */
import { BadRequestException } from '@nestjs/common';
import { normalizeUnicode } from './unicode.util';

export interface SanitizeFilenameOptions {
  /** Max total length incl. extension. Default 255 (the common filesystem limit). */
  readonly maxLength?: number;
  /** Case-insensitive, with or without the leading dot. Absent = no extension restriction. */
  readonly allowedExtensions?: readonly string[];
  /** Default `true`. */
  readonly stripLeadingDots?: boolean;
}

const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function sanitizeFilename(input: string, options: SanitizeFilenameOptions = {}): string {
  const maxLength = options.maxLength ?? 255;
  if (!Number.isInteger(maxLength) || maxLength < 1 || maxLength > 255) {
    throw new RangeError('sanitizeFilename(): maxLength must be an integer between 1 and 255');
  }

  let name = normalizeUnicode(String(input));
  name = name.split(/[\\/]/).pop() ?? ''; // basename only
  name = name.replace(/[\u0000-\u001F\u007F<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  name = name.replace(/[. ]+$/, ''); // trailing dots/spaces
  if (options.stripLeadingDots ?? true) name = name.replace(/^\.+/, '');

  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot) : '';
  if (WINDOWS_DEVICE_RE.test(base)) base = `_${base}`;

  if (options.allowedExtensions) {
    const allowed = new Set(options.allowedExtensions.map((e) => e.replace(/^\./, '').toLowerCase()));
    if (!allowed.has(ext.slice(1).toLowerCase())) {
      throw new BadRequestException('File extension is not allowed');
    }
  }

  if (ext.length >= maxLength) ext = ext.slice(0, maxLength - 1);
  if (base.length + ext.length > maxLength) base = base.slice(0, Math.max(1, maxLength - ext.length));
  base = base.replace(/[. ]+$/, '');

  const out = `${base}${ext}`;
  return out === '' ? 'file' : out;
}
