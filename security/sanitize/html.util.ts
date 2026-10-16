/**
 * HTML sanitiser — Security spec §13. Allowlist-based, built on `sanitize-html` (a
 * well-maintained htmlparser2-based sanitiser — an HTML sanitiser is exactly the kind of
 * code that must not be hand-rolled).
 *
 * The PROFILE IS MANDATORY on every call (anti-pattern #7: an implicit default is how a
 * comment field ends up with the permissive policy meant for an article body):
 *
 *   'strict'            no markup survives; text content is kept, HTML-escaped.
 *                       `<script>`/`<style>`/`<textarea>`/`<option>` lose their CONTENT too.
 *   'basic-formatting'  b/strong/i/em/u/s/p/br/ul/ol/li/blockquote/code/pre and links.
 *                       Links: http/https/mailto only, no protocol-relative URLs, and
 *                       `rel="noopener noreferrer nofollow"` is forced (any author-supplied
 *                       `rel` is overwritten). No styles, no classes, no ids, no event
 *                       handlers, no images.
 */
import sanitize from 'sanitize-html';

type IOptions = sanitize.IOptions;

export type HtmlSanitizeProfile = 'strict' | 'basic-formatting';

const COMMON: IOptions = {
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  parser: { decodeEntities: true },
};

const OPTIONS: Readonly<Record<HtmlSanitizeProfile, IOptions>> = Object.freeze({
  strict: Object.freeze({ ...COMMON, allowedTags: [], allowedAttributes: {} }),
  'basic-formatting': Object.freeze({
    ...COMMON,
    allowedTags: ['b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a'],
    allowedAttributes: { a: ['href', 'title', 'rel'] },
    transformTags: {
      a: sanitize.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
    },
  }),
});

export function sanitizeHtml(input: string, profile: HtmlSanitizeProfile): string {
  if (profile !== 'strict' && profile !== 'basic-formatting') {
    throw new TypeError("sanitizeHtml(): an explicit profile ('strict' | 'basic-formatting') is required");
  }
  if (typeof input !== 'string') return '';
  return sanitize(input, OPTIONS[profile]);
}
