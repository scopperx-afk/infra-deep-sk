import type { ArgumentsHost } from '@nestjs/common';
import type { ILogger } from '../../logger';
import type { ErrorMapper, MappedError } from '../mapping/error-mapper.port';
import type { ErrorsMetricsCollector } from '../metrics/errors.metrics';
import { WsExceptionFilter } from './ws-exception.filter';

function fakeWsHost(client: { emit: jest.Mock }): ArgumentsHost {
  return {
    switchToWs: () => ({
      getClient: () => client,
      getData: () => undefined,
      getPattern: () => '',
    }),
  } as unknown as ArgumentsHost;
}

describe('WsExceptionFilter (§9)', () => {
  const mapped: MappedError = {
    status: 400,
    body: {
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: [],
    },
    category: 'validation',
  };

  it('emits the identical ErrorResponseBody shape the HTTP path would produce, via the SAME mapper', () => {
    const emit = jest.fn();
    const mapper: ErrorMapper = { mapToErrorResponse: jest.fn(() => mapped) };
    const logger: ILogger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as unknown as ILogger;
    const metrics: ErrorsMetricsCollector = {
      record: jest.fn(),
      getMetricsSnapshot: jest.fn(),
    };

    const filter = new WsExceptionFilter(mapper, logger, metrics);
    const exception = new Error('bad payload');
    filter.catch(exception, fakeWsHost({ emit }));

    expect(mapper.mapToErrorResponse).toHaveBeenCalledWith(exception);
    expect(emit).toHaveBeenCalledWith('error', mapped.body);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('WS Request rejected', {
      code: 'VALIDATION_ERROR',
      status: 400,
      errorName: 'Error',
    });
    expect(metrics.record).toHaveBeenCalledWith(
      'validation',
      400,
      'VALIDATION_ERROR',
    );
  });

  it('never touches an HTTP-shaped response object — only client.emit()', () => {
    const emit = jest.fn();
    const mapper: ErrorMapper = { mapToErrorResponse: jest.fn(() => mapped) };
    const logger: ILogger = { error: jest.fn() } as unknown as ILogger;
    const metrics: ErrorsMetricsCollector = {
      record: jest.fn(),
      getMetricsSnapshot: jest.fn(),
    };
    const client = { emit };

    const filter = new WsExceptionFilter(mapper, logger, metrics);
    expect(() =>
      filter.catch(new Error('x'), fakeWsHost(client)),
    ).not.toThrow();
    expect(Object.keys(client)).toEqual(['emit']); // nothing else was ever called on the client
  });
});
