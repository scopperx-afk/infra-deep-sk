/**
 * Webhook signature verification with replay protection — Security spec §15.3, §18.1.
 *
 * HMAC over the RAW, unparsed request body (HTTP's `body-parser.config.ts` stashes it on
 * `req.rawBody`) — never over a re-serialised `req.body`, which can differ byte-for-byte
 * from what the provider signed. Comparison is constant-time. This is the primitive an
 * HTTP-side concrete `WebhookVerificationGuard` subclass calls (plain-function import,
 * §13's pattern — never a `SecurityModule` import).
 *
 * ── SPEC-ERRATA E-S4 — the wire scheme ───────────────────────────────────────────────
 * §15.3 fixes the signature `(req, secret, { toleranceSeconds, algorithm })` but not which
 * headers carry the signature and timestamp (every provider differs). This implementation
 * defines ONE generic, documented default and lets the caller point it at a provider's
 * own header names:
 *
 *   signature header  `x-signature`           hex digest, optionally `sha256=`-prefixed;
 *                                             several space/comma-separated values are
 *                                             accepted (secret rotation)
 *   timestamp header  `x-signature-timestamp` unix seconds (or ms)
 *   signed content    `${timestamp}.${rawBody}`  → HMAC(secret) → hex
 *
 * `timestampHeader: null` opts out of the timestamp (body-only HMAC) for providers that
 * carry a nonce instead — freshness is then NOT established here and the caller MUST add
 * `ReplayProtectionStore.checkAndMark()` (§18.2).
 *
 * Signature validity alone does not prove freshness: with the timestamp scheme a
 * genuinely-signed but stale payload (older/newer than `toleranceSeconds`) fails exactly
 * like a forged one. A missing/malformed timestamp is a FAILURE, never "skip the check".
 *
 * Never throws: every malformed input is simply `false`.
 */
import { createHmac } from 'node:crypto';
import { systemClock } from '../util/clock';
import { constantTimeEquals } from './compare.util';

export interface RawRequest {
  /** Set by HTTP's body parser. `undefined` ⇒ verification FAILS (never "skipped"). */
  readonly rawBody?: Buffer | undefined;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface VerifySignatureOptions {
  /** Max |now − timestamp| in seconds. Default 300. */
  readonly toleranceSeconds?: number;
  /** HMAC hash. Default `sha256`; `sha1` exists for legacy providers only. */
  readonly algorithm?: 'sha256' | 'sha1';
  /** Default `x-signature`. */
  readonly signatureHeader?: string;
  /** Default `x-signature-timestamp`; `null` = body-only HMAC (caller must add replay protection). */
  readonly timestampHeader?: string | null;
  /** Test hook — epoch ms. Defaults to the system clock. */
  readonly nowMs?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const MAX_TOLERANCE_SECONDS = 86_400;
const MAX_SIGNATURE_CANDIDATES = 5;
const HEX_RE = /^[0-9a-f]+$/;
const DIGEST_HEX_LENGTH = { sha256: 64, sha1: 40 } as const;

function singleHeader(
  headers: RawRequest['headers'],
  name: string,
): string | undefined {
  const v = headers[name];
  // Duplicate headers (string[]) are ambiguous framing of a security value → reject.
  return typeof v === 'string' ? v : undefined;
}

function parseSignatureCandidates(raw: string | undefined, algorithm: 'sha256' | 'sha1'): string[] {
  if (!raw) return [];
  const prefix = `${algorithm}=`;
  const out: string[] = [];
  for (const token of raw.split(/[\s,]+/)) {
    if (token === '') continue;
    const lowered = token.toLowerCase();
    const hex = lowered.startsWith(prefix) ? lowered.slice(prefix.length) : lowered;
    if (hex.length === DIGEST_HEX_LENGTH[algorithm] && HEX_RE.test(hex)) out.push(hex);
    if (out.length >= MAX_SIGNATURE_CANDIDATES) break;
  }
  return out;
}

/** Unix seconds from digits only; a value this large is milliseconds. */
function parseTimestampSeconds(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,13}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 99_999_999_999 ? n / 1000 : n;
}

export function verifySignature(
  req: RawRequest,
  secret: string,
  opts: VerifySignatureOptions = {},
): boolean {
  try {
    if (typeof secret !== 'string' || secret.length === 0) return false;
    const raw = req.rawBody;
    if (!Buffer.isBuffer(raw)) return false;

    const algorithm = opts.algorithm ?? 'sha256';
    if (algorithm !== 'sha256' && algorithm !== 'sha1') return false;

    const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > MAX_TOLERANCE_SECONDS) return false;

    const signatureHeader = (opts.signatureHeader ?? 'x-signature').toLowerCase();
    const candidates = parseSignatureCandidates(singleHeader(req.headers, signatureHeader), algorithm);
    if (candidates.length === 0) return false;

    let signedContent: Buffer;
    if (opts.timestampHeader === null) {
      signedContent = raw;
    } else {
      const timestampHeader = (opts.timestampHeader ?? 'x-signature-timestamp').toLowerCase();
      const timestampRaw = singleHeader(req.headers, timestampHeader);
      const timestamp = parseTimestampSeconds(timestampRaw);
      if (timestamp === undefined) return false;
      const nowSeconds = (opts.nowMs ?? systemClock.nowMs()) / 1000;
      if (Math.abs(nowSeconds - timestamp) > tolerance) return false;
      signedContent = Buffer.concat([Buffer.from(`${timestampRaw as string}.`, 'utf8'), raw]);
    }

    const expected = createHmac(algorithm, secret).update(signedContent).digest('hex');
    // No early exit: every candidate is compared, so timing never reveals WHICH one matched.
    let matched = false;
    for (const candidate of candidates) {
      if (constantTimeEquals(candidate, expected)) matched = true;
    }
    return matched;
  } catch {
    return false;
  }
}
