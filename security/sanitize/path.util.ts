/**
 * Path-traversal defences — Security spec §13.
 *
 * `sanitizePathSegment` turns attacker input into ONE safe path segment (it never returns a
 * separator, so it can only ever name a child). `isPathWithin` is the containment check to
 * run on the RESOLVED path before touching the filesystem.
 *
 * Neither follows symlinks: a link planted inside `baseDir` that points outside it defeats
 * a purely lexical check. Callers that serve from a directory an attacker can write links
 * into must additionally compare `fs.realpath()` results.
 */
import path from 'node:path';

const MAX_SEGMENT_LENGTH = 255;

export function sanitizePathSegment(input: string): string {
  let s = String(input)
    .replace(/[\u0000-\u001F\u007F]/g, '') // NUL & control characters
    .replace(/^[A-Za-z]:/, ''); // Windows drive prefix (C:)
  const parts = s.split(/[\\/]+/).filter((p) => p !== '' && p !== '.' && p !== '..');
  s = parts.join('_');
  while (s.includes('..')) s = s.replace(/\.\.+/g, '.'); // a..b → a.b (no residual traversal token)
  s = s.replace(/^\.+/, '').replace(/[. ]+$/, ''); // no hidden-file / Windows-trailing tricks
  s = s.slice(0, MAX_SEGMENT_LENGTH);
  return s === '' ? '_' : s;
}

export function isPathWithin(baseDir: string, targetPath: string): boolean {
  if (typeof baseDir !== 'string' || typeof targetPath !== 'string') return false;
  if (baseDir.includes('\u0000') || targetPath.includes('\u0000')) return false;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, targetPath); // a relative target is interpreted INSIDE base
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
