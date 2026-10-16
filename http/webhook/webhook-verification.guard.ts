/**
 * `WebhookVerificationGuard` — HTTP spec §10. The reusable PATTERN, not a
 * concrete provider integration — Stripe/Twilio/GitHub each define their own
 * signature scheme, so `verifySignature()` is abstract; a concrete webhook
 * controller (wherever that provider's integration eventually lives) extends
 * this class and implements it, then applies the result the normal Nest way:
 * `@UseGuards(SomeConcreteWebhookGuard)`.
 *
 * Reads `req.rawBody` (see `middleware/body-parser.config.ts`), never
 * `req.body` — most real signature schemes sign the raw bytes, and a
 * re-serialized `JSON.stringify(req.body)` is not guaranteed byte-identical
 * to what the sender actually signed.
 *
 * `security.webhookSigning.secret`/`toleranceSeconds` (Config catalog §13.12)
 * belong to the (not yet built) Security module's own namespace — using this
 * guard before Security registers that namespace is a genuine configuration
 * gap to fix by building/registering Security, not something this guard
 * papers over with a fallback (unlike `security.trustProxy` in
 * `bootstrap/platform.adapter.ts`, which HTTP needs at BOOT time regardless
 * of whether Security exists yet — see that file's own comment).
 */
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { CONFIG_SERVICE, type ConfigService } from '../../config';
import type { RequestWithRawBody } from '../middleware/body-parser.config';

@Injectable()
export abstract class WebhookVerificationGuard implements CanActivate {
  constructor(@Inject(CONFIG_SERVICE) protected readonly config: ConfigService) {}

  /** Returns true iff the request's signature is valid. Receives the raw body
   *  bytes (may be `undefined` if body-parser never ran for this route/content-type
   *  — treat that as verification failure, never as "skip the check"),
   *  the configured secret, and the replay-protection tolerance window. */
  protected abstract verifySignature(
    req: RequestWithRawBody,
    secret: string,
    toleranceSeconds: number,
  ): boolean | Promise<boolean>;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithRawBody>();
    const secret = this.config.get<string>('security.webhookSigning.secret');
    const toleranceSeconds = this.config.get<number>('security.webhookSigning.toleranceSeconds');
    return this.verifySignature(req, secret, toleranceSeconds);
  }
}
