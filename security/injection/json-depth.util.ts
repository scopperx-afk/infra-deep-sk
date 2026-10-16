/**
 * JSON nesting-depth bound — Security spec §14 (stack overflow / memory exhaustion via
 * deeply nested payloads). Iterative: the check itself cannot be crashed by the payload it
 * is checking. A cyclic structure keeps growing deeper until it trips the limit, so it
 * terminates too.
 *
 * Throws 400 (Nest's own `BadRequestException` → Errors maps it; anti-pattern #6).
 */
import { BadRequestException } from '@nestjs/common';
import { getSecurityRuntime } from '../runtime/security-runtime';

/** Default ceiling; `security.injection.maxJsonDepth` overrides it at runtime. */
export const MAX_JSON_DEPTH = 20;

/** Depth of a scalar is 0, of `{a: 1}` is 1, of `{a: {b: 1}}` is 2. */
export function checkJsonDepth(obj: unknown, maxDepth?: number): void {
  const limit = maxDepth ?? getSecurityRuntime().injection.maxJsonDepth;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('checkJsonDepth(): maxDepth must be a positive integer');
  if (typeof obj !== 'object' || obj === null) return;
  const stack: Array<{ node: object; depth: number }> = [{ node: obj, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop() as { node: object; depth: number };
    if (depth > limit) {
      throw new BadRequestException(`JSON nesting exceeds the maximum depth of ${limit}`);
    }
    for (const child of Object.values(node as Record<string, unknown>)) {
      if (typeof child === 'object' && child !== null) stack.push({ node: child, depth: depth + 1 });
    }
  }
}
