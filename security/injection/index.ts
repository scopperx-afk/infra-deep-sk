/** Injection-prevention utilities — Security spec §14. Plain, no-DI functions. */
export { isPrototypeSafe, safeMerge, sanitizeObjectKeys } from './prototype-pollution.util';
export { isRegexSafe, safeRegex } from './redos.util';
export { checkJsonDepth, MAX_JSON_DEPTH } from './json-depth.util';
export { createSafeXmlParser } from './xml-parser.util';
