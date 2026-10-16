/** Network utilities — Security spec §8.3, §16. */
export { isIpAllowed, createIpFilterMiddleware } from './ip-filter.util';
export type { IpPolicy } from './ip-filter.util';
export { configureTrustProxy } from './trusted-proxy.util';
