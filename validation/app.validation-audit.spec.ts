/**
 * CI guard: every route input of the REAL application graph is validated.
 *
 * `ZodValidationPipe` validates only parameters typed as a `createZodDto()` class — a forgotten DTO
 * (`@Body() body: SomeInterface`) would otherwise reach a handler completely unvalidated, with no warning.
 * This test boots the application module and fails, listing every offender, if that ever happens.
 *
 * To accept an input ON PURPOSE (a signed webhook that verifies the raw body, a file upload), pass `ignore`:
 *   assertRouteInputsValidated(app, { ignore: (f) => f.controller === 'StripeWebhookController' });
 */
import { Test } from '@nestjs/testing';
import { AppModule } from '../../app.module';
import { assertRouteInputsValidated } from './';

describe('route inputs are validated', () => {
  it('every @Body() / whole-object @Query() / @Param() is a createZodDto() class (or has its own pipe)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    try {
      await app.init();
      assertRouteInputsValidated(app);
    } finally {
      await app.close();
    }
  });
});
