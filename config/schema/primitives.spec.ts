import { z } from 'zod';
import {
  booleanSchema,
  csvArray,
  durationSchema,
  mimeSchema,
  numberSchema,
  portSchema,
  secretValueSchema,
} from './primitives';

describe('primitives (§7.10)', () => {
  it('portSchema coerces and bounds', () => {
    expect(portSchema.parse('5432')).toBe(5432);
    expect(() => portSchema.parse('0')).toThrow();
    expect(() => portSchema.parse('70000')).toThrow();
    expect(() => portSchema.parse('abc')).toThrow();
  });

  it('durationSchema normalizes to SECONDS', () => {
    expect(durationSchema.parse('900s')).toBe(900);
    expect(durationSchema.parse('30d')).toBe(2_592_000);
    expect(durationSchema.parse('2h')).toBe(7200);
    expect(durationSchema.parse('1500ms')).toBe(1.5);
    expect(durationSchema.parse('5m')).toBe(300);
    expect(() => durationSchema.parse('30')).toThrow();
    expect(() => durationSchema.parse('1w')).toThrow();
    expect(() => durationSchema.parse('-5s')).toThrow();
  });

  it('mimeSchema', () => {
    expect(mimeSchema.parse('image/jpeg')).toBe('image/jpeg');
    expect(mimeSchema.parse('application/vnd.api+json')).toBeTruthy();
    expect(() => mimeSchema.parse('jpeg')).toThrow();
  });

  it('secretValueSchema rejects empty', () => {
    expect(() => secretValueSchema.parse('')).toThrow();
    expect(secretValueSchema.parse('x')).toBe('x');
  });

  it('csvArray splits, trims, validates items; empty string is an empty list', () => {
    const s = csvArray(z.string().url());
    expect(s.parse('http://a.com, http://b.com')).toEqual([
      'http://a.com',
      'http://b.com',
    ]);
    expect(s.parse('')).toEqual([]);
    expect(() => s.parse('http://a.com,,http://b.com')).toThrow(); // stray comma is visible, not swallowed
    expect(() => s.parse('nope')).toThrow();
  });

  it('booleanSchema is strict (no "false" → true trap)', () => {
    expect(booleanSchema.parse('true')).toBe(true);
    expect(booleanSchema.parse('FALSE')).toBe(false);
    expect(booleanSchema.parse('1')).toBe(true);
    expect(booleanSchema.parse('0')).toBe(false);
    expect(() => booleanSchema.parse('yes')).toThrow();
    expect(() => booleanSchema.parse('')).toThrow();
  });

  it('numberSchema: empty string is NOT 0', () => {
    expect(numberSchema.parse('42')).toBe(42);
    expect(numberSchema.parse('1.5')).toBe(1.5);
    expect(() => numberSchema.parse('')).toThrow();
    expect(() => numberSchema.parse('abc')).toThrow();
  });
});
