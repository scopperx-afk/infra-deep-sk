import express from 'express';
import http from 'node:http';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { applyBodyParsers, type RequestWithRawBody } from './body-parser.config';
import { normalizeBodyParserErrors } from './body-parser-error.middleware';

function post(port: number, path: string, body: string, contentType = 'application/json'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { port, path, method: 'POST', headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as { port: number }).port;
}

describe('normalizeBodyParserErrors() (§6)', () => {
  it('converts a 413-shaped http-errors object into a real PayloadTooLargeException', () => {
    const next = jest.fn();
    const err = Object.assign(new Error('request entity too large'), { status: 413, type: 'entity.too.large' });
    normalizeBodyParserErrors(err, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.any(PayloadTooLargeException));
    const passed = next.mock.calls[0][0] as PayloadTooLargeException;
    expect(passed.getStatus()).toBe(413);
  });

  it('converts a 400-shaped http-errors object (malformed JSON) into a real BadRequestException', () => {
    const next = jest.fn();
    const err = Object.assign(new SyntaxError('Unexpected token'), { status: 400 });
    normalizeBodyParserErrors(err, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.any(BadRequestException));
  });

  it('passes through an unrecognized status unchanged, rather than inventing a mapping', () => {
    const next = jest.fn();
    const err = Object.assign(new Error('teapot'), { status: 418 });
    normalizeBodyParserErrors(err, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(err); // unchanged
  });

  it('never touches an error that is already a real HttpException (has getStatus)', () => {
    const next = jest.fn();
    const real = new BadRequestException('already real');
    normalizeBodyParserErrors(real, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(real); // the exact same instance, not re-wrapped
  });

  it('passes through a completely ordinary Error with no status at all', () => {
    const next = jest.fn();
    const err = new Error('something else entirely');
    normalizeBodyParserErrors(err, {} as never, {} as never, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('applyBodyParsers() — real end-to-end behavior (§6)', () => {
  function buildApp(bodyLimit: string): { app: express.Express; errors: unknown[] } {
    const app = express();
    const errors: unknown[] = [];
    applyBodyParsers(app, bodyLimit);
    app.post('/upload', (req: RequestWithRawBody, res) => {
      res.json({ ok: true, body: req.body, hasRawBody: Buffer.isBuffer(req.rawBody) });
    });
    // Express error-handling convention: a 4-arg function registered last catches whatever
    // normalizeBodyParserErrors (itself already applied inside applyBodyParsers) passed along.
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      errors.push(err);
      const status = err instanceof PayloadTooLargeException || err instanceof BadRequestException ? err.getStatus() : 500;
      res.status(status).json({ convertedToRealHttpException: err instanceof PayloadTooLargeException || err instanceof BadRequestException });
    });
    return { app, errors };
  }

  it('parses a normal, well-sized JSON body and exposes rawBody for webhook verification', async () => {
    const { app } = buildApp('1mb');
    const server = http.createServer(app);
    const port = await listen(server);
    try {
      const res = await post(port, '/upload', JSON.stringify({ x: 1 }));
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body);
      expect(parsed).toEqual({ ok: true, body: { x: 1 }, hasRawBody: true });
    } finally {
      server.close();
    }
  });

  it('an oversized body is rejected as a real, recognizable HttpException (413)', async () => {
    const { app } = buildApp('10b');
    const server = http.createServer(app);
    const port = await listen(server);
    try {
      const res = await post(port, '/upload', JSON.stringify({ data: 'x'.repeat(1000) }));
      expect(res.status).toBe(413);
      expect(JSON.parse(res.body).convertedToRealHttpException).toBe(true);
    } finally {
      server.close();
    }
  });

  it('malformed JSON (within the size limit) is rejected as a real, recognizable HttpException (400)', async () => {
    const { app } = buildApp('1mb'); // generous limit — isolates the malformed-JSON path specifically
    const server = http.createServer(app);
    const port = await listen(server);
    try {
      const res = await post(port, '/upload', '{ not valid json');
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).convertedToRealHttpException).toBe(true);
    } finally {
      server.close();
    }
  });

  it('bodyLimit is passed straight through to express — "1kb" behaves as express itself defines it', async () => {
    const { app } = buildApp('1kb');
    const server = http.createServer(app);
    const port = await listen(server);
    try {
      const withinLimit = await post(port, '/upload', JSON.stringify({ data: 'x'.repeat(100) }));
      expect(withinLimit.status).toBe(200);
      const overLimit = await post(port, '/upload', JSON.stringify({ data: 'x'.repeat(2000) }));
      expect(overLimit.status).toBe(413);
    } finally {
      server.close();
    }
  });
});
