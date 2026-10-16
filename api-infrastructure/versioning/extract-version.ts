/**
 * `extractApiVersion()` — API Infrastructure spec §8.2.
 *
 * Reads the version from the SAME path the router matched — never from a client-supplied header
 * (§8.1: URL-based versioning; a header would let a client claim a version its URL did not reach).
 * NestJS's router already 404s an unregistered version, so this only REPORTS one.
 *
 * Deviation E-A7: §13's test list says the version is "the segment that matches `^v\d+$`, not
 * necessarily the first segment". Searching the WHOLE path would misread any deeper segment that
 * happens to look like a version (`/projects/123/v2/tasks`, `/files/v3`) as the API version. Only
 * the first TWO segments are considered — enough for one global prefix (`/api/v1/...`), which is
 * the only thing that legitimately precedes the version — and the result is lower-cased (Express
 * routing is case-insensitive, so `/V1/x` serves `v1`).
 *
 * Known residual ambiguity, stated plainly: without knowing the deployment's global prefix, a
 * resource literally named `v2` in SECOND position (`/projects/v2`) has exactly the same shape as
 * `/api/v2` and is reported as a version. The cost is a wrong `meta.apiVersion` string — it never
 * affects routing, which Nest's router decides on its own. A project whose first path segment can
 * be such a resource should route versions through a global prefix of its own.
 */
const VERSION_SEGMENT = /^v\d{1,4}$/i;
const SEARCH_WINDOW = 2;

export function extractApiVersion(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0) return null;
  let end = path.length;
  const q = path.indexOf('?');
  if (q !== -1) end = q;
  const h = path.indexOf('#');
  if (h !== -1 && h < end) end = h;

  let segments = 0;
  let start = 0;
  while (start < end && segments < SEARCH_WINDOW) {
    while (start < end && path.charCodeAt(start) === 47 /* '/' */) start++;
    if (start >= end) break;
    let stop = path.indexOf('/', start);
    if (stop === -1 || stop > end) stop = end;
    const segment = path.slice(start, stop);
    if (VERSION_SEGMENT.test(segment)) return segment.toLowerCase();
    segments++;
    start = stop;
  }
  return null;
}
