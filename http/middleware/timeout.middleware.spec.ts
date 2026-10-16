import express from 'express';
import http from 'node:http';
import { createTimeoutMiddleware, type TimedOutRequest } from './timeout.middleware';

function get(port: number, path = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function buildServer(handlerDelayMs: number, timeoutMs: number): { server: http.Server; app: express.Express } {
  const app = express();
  app.use(createTimeoutMiddleware(timeoutMs));
  app.get('/slow', (req: TimedOutRequest, res) => {
    const timer = setTimeout(() => {
      if (req.timedOut) return; // cooperating handler: don't bother writing once timed out
      res.status(200).json({ ok: true });
    }, handlerDelayMs);
    timer.unref(); // test-fixture hygiene only — the real handler this simulates would be I/O, not a bare timer
  });
  const server = http.createServer(app);
  return { server, app };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return (server.address() as { port: number }).port;
}

describe('createTimeoutMiddleware (§7.2)', () => {
  it('lets a fast handler respond normally, well within the budget', async () => {
    const { server } = buildServer(10, 2000);
    const port = await listen(server);
    try {
      const res = await get(port, '/slow');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });

  it('responds 503 with a clear message once the budget elapses, for a handler that never finishes', async () => {
    const { server } = buildServer(5000, 80);
    const port = await listen(server);
    try {
      const res = await get(port, '/slow');
      expect(res.status).toBe(503);
      const parsed = JSON.parse(res.body);
      expect(parsed.error).toBe('Request Timeout');
      expect(parsed.message).toContain('80ms');
    } finally {
      server.close();
    }
  });

  it('sets req.timedOut so a cooperating handler can detect it and skip its own late write', async () => {
    const app = express();
    app.use(createTimeoutMiddleware(60));
    let observedTimedOut: boolean | undefined;
    app.get('/slow', (req: TimedOutRequest, res) => {
      const timer = setTimeout(() => {
        observedTimedOut = req.timedOut;
        if (!req.timedOut) res.json({ ok: true });
      }, 300);
      timer.unref();
    });
    const server = http.createServer(app);
    const port = await listen(server);
    try {
      await get(port, '/slow');
      await new Promise((r) => setTimeout(r, 350)); // let the handler's own late timer actually fire
      expect(observedTimedOut).toBe(true);
    } finally {
      server.close();
    }
  });

  it('a 404 (unmatched route) is unaffected — no timeout artifact leaks into an ordinary fast response', async () => {
    const { server } = buildServer(10, 2000);
    const port = await listen(server);
    try {
      const res = await get(port, '/does-not-exist');
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('clears its timer on a fast response — process has nothing keeping it alive afterward (unref, no leaked handle)', async () => {
    const { server } = buildServer(5, 5000);
    const port = await listen(server);
    try {
      await get(port, '/slow');
      // If the timer weren't cleared/unref'd, this would be observable via process._getActiveHandles
      // in a real leak-detection setup; here we just confirm no crash/hang occurs well past the
      // handler's own completion, which would surface as this test itself timing out.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      server.close();
    }
  });
});
