/**
 * Content-Security-Policy assembly from `security.headers.csp.*`.
 *
 * Built ONCE at startup into a small closure; per request the only variable part is the
 * nonce. Directive sources have already been validated by the schema (no whitespace, `;`
 * or `,`), so joining them cannot inject a new directive.
 */
import type { SecurityConfig } from '../config/security.schema';

export type CspConfig = SecurityConfig['headers']['csp'];

export interface CspHeader {
  /** `Content-Security-Policy` or `Content-Security-Policy-Report-Only`. */
  readonly name: string;
  readonly usesNonce: boolean;
  /** The header VALUE; pass the request's nonce when `usesNonce`. */
  build(nonce?: string): string;
}

interface Directive {
  readonly name: string;
  readonly sources: readonly string[];
  readonly nonceable: boolean;
}

export function buildCspHeader(csp: CspConfig): CspHeader | undefined {
  if (!csp.enabled) return undefined;

  const directives: Directive[] = [
    { name: 'default-src', sources: csp.defaultSrc, nonceable: false },
    { name: 'script-src', sources: csp.scriptSrc, nonceable: true },
    { name: 'style-src', sources: csp.styleSrc, nonceable: true },
    { name: 'img-src', sources: csp.imgSrc, nonceable: false },
    { name: 'font-src', sources: csp.fontSrc, nonceable: false },
    { name: 'connect-src', sources: csp.connectSrc, nonceable: false },
    { name: 'frame-src', sources: csp.frameSrc, nonceable: false },
    { name: 'object-src', sources: csp.objectSrc, nonceable: false },
    { name: 'base-uri', sources: csp.baseUri, nonceable: false },
    { name: 'form-action', sources: csp.formAction, nonceable: false },
    { name: 'frame-ancestors', sources: csp.frameAncestors, nonceable: false },
  ].filter((d) => d.sources.length > 0);

  const tail: string[] = [];
  if (csp.upgradeInsecureRequests) tail.push('upgrade-insecure-requests');
  if (csp.reportUri !== undefined) tail.push(`report-uri ${csp.reportUri}`);

  // A nonce is only meaningful on a directive that exists to attach it to.
  const usesNonce = csp.useNonce && directives.some((d) => d.nonceable);

  const render = (nonce?: string): string =>
    [
      ...directives.map((d) => {
        const sources = usesNonce && d.nonceable && nonce ? [...d.sources, `'nonce-${nonce}'`] : d.sources;
        return `${d.name} ${sources.join(' ')}`;
      }),
      ...tail,
    ].join('; ');

  const staticValue = usesNonce ? undefined : render();
  return {
    name: csp.reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy',
    usesNonce,
    build: (nonce?: string): string => staticValue ?? render(nonce),
  };
}
