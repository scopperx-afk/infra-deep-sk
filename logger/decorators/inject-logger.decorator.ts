/**
 * `@InjectLogger()` — Logger spec §32. Pure sugar for `@Inject(LOGGER_SERVICE)`;
 * exists only so a consumer never has to import the token directly for the
 * single most common case (every module wanting `ILogger`).
 */
import { Inject } from '@nestjs/common';
import { LOGGER_SERVICE } from '../logger.tokens';

export const InjectLogger = (): ParameterDecorator & PropertyDecorator =>
  Inject(LOGGER_SERVICE);
