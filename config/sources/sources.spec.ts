import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DotenvConfigSource } from './dotenv.source';
import { EnvironmentConfigSource } from './env.source';
import { staticSource } from './static.source';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cfg-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, body: string) =>
  writeFileSync(path.join(dir, name), body);

describe('DotenvConfigSource (§5.2)', () => {
  it('parses with dotenv.parse(): NEVER mutates process.env', async () => {
    write('.env', 'ZZ_TEST_LEAK__CHECK=leaked\n');
    const before = { ...process.env };
    const raw = await new DotenvConfigSource({
      cwd: dir,
      nodeEnv: 'test',
    }).load();
    expect(raw['ZZ_TEST_LEAK__CHECK']).toEqual({
      value: 'leaked',
      origin: 'committed-file',
    });
    expect(process.env['ZZ_TEST_LEAK__CHECK']).toBeUndefined();
    expect(process.env).toEqual(before);
  });

  it('layers .env < .env.{NODE_ENV} < .env.local < .env.{NODE_ENV}.local, with origins', async () => {
    write('.env', 'A__X=base\nA__ONLY_BASE=b\n');
    write('.env.test', 'A__X=env\nA__ONLY_ENV=e\n');
    write('.env.local', 'A__X=local\nA__ONLY_LOCAL=l\n');
    write('.env.test.local', 'A__Y=envlocal\n');
    const raw = await new DotenvConfigSource({
      cwd: dir,
      nodeEnv: 'test',
    }).load();
    expect(raw['A__X']).toEqual({ value: 'local', origin: 'local-file' });
    expect(raw['A__ONLY_BASE']?.origin).toBe('committed-file');
    expect(raw['A__ONLY_ENV']?.origin).toBe('committed-file');
    expect(raw['A__Y']).toEqual({ value: 'envlocal', origin: 'local-file' });
  });

  it('a missing file is fine; no files at all gives an empty result', async () => {
    expect(
      await new DotenvConfigSource({ cwd: dir, nodeEnv: 'production' }).load(),
    ).toEqual({});
  });

  it('takes NODE_ENV from .env when the process has none', async () => {
    write('.env', 'NODE_ENV=development\n');
    write('.env.development', 'A__X=from-dev-file\n');
    const saved = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const raw = await new DotenvConfigSource({ cwd: dir }).load();
      expect(raw['A__X']?.value).toBe('from-dev-file');
    } finally {
      if (saved !== undefined) process.env.NODE_ENV = saved;
    }
  });

  it('never builds a file name from an unsafe NODE_ENV', async () => {
    write('.env', 'A__X=1\n');
    const raw = await new DotenvConfigSource({
      cwd: dir,
      nodeEnv: '../../etc/passwd',
    }).load();
    expect(Object.keys(raw)).toEqual(['A__X']);
  });

  it('an unreadable file (here: a directory named .env) is fatal for a critical source', async () => {
    mkdirSync(path.join(dir, '.env'));
    const src = new DotenvConfigSource({ cwd: dir, nodeEnv: 'test' });
    await expect(src.load()).rejects.toThrow(/cannot read \.env/);
    expect((await src.health()).healthy).toBe(false);
  });
});

describe('_FILE convention (§5.2)', () => {
  it('outside the working tree → process.env-equivalent provenance; contents untrimmed', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'secrets-'));
    try {
      const pem = '-----BEGIN KEY-----\nabc\n-----END KEY-----\n';
      writeFileSync(path.join(outside, 'key.pem'), pem);
      const src = new EnvironmentConfigSource(
        { NOTIFICATIONS__APNS__KEY_REF_FILE: path.join(outside, 'key.pem') },
        dir, // working tree = dir; the key lives outside it
      );
      const raw = await src.load();
      expect(raw['NOTIFICATIONS__APNS__KEY_REF']).toEqual({
        value: pem,
        origin: 'process.env',
        viaFile: true,
      });
      expect(raw['NOTIFICATIONS__APNS__KEY_REF_FILE']).toBeUndefined();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('inside the repo tree → committed-file (the production guard will then block it)', async () => {
    write('key.pem', 'KEYDATA');
    const src = new EnvironmentConfigSource(
      { X__KEY_FILE: path.join(dir, 'key.pem') },
      dir,
    );
    expect((await src.load())['X__KEY']).toMatchObject({
      value: 'KEYDATA',
      origin: 'committed-file',
      viaFile: true,
    });
  });

  it('KEY and KEY_FILE both set is an error, not a silent pick', async () => {
    write('k', 'v');
    const src = new EnvironmentConfigSource(
      { X__KEY: 'a', X__KEY_FILE: path.join(dir, 'k') },
      dir,
    );
    await expect(src.load()).rejects.toThrow(/both set/);
  });

  it('an unreadable _FILE fails the load and never echoes contents', async () => {
    const src = new EnvironmentConfigSource(
      { X__KEY_FILE: path.join(dir, 'missing') },
      dir,
    );
    await expect(src.load()).rejects.toThrow(/cannot read/);
  });

  it('unrelated variables that merely end in _FILE are never read', async () => {
    const src = new EnvironmentConfigSource(
      { SSL_CERT_FILE: '/definitely/not/there', A__B: '1' },
      dir,
    );
    const raw = await src.load();
    expect(raw['SSL_CERT_FILE']).toEqual({
      value: '/definitely/not/there',
      origin: 'process.env',
    });
    expect(raw['A__B']?.value).toBe('1');
  });
});

describe('EnvironmentConfigSource / staticSource', () => {
  it('tags process.env values; skips undefined', async () => {
    const raw = await new EnvironmentConfigSource(
      { A__B: 'x', GONE: undefined },
      dir,
    ).load();
    expect(raw).toEqual({ A__B: { value: 'x', origin: 'process.env' } });
  });

  it('staticSource stringifies non-strings and tags test-override', async () => {
    const raw = await staticSource({
      A__N: 5,
      A__B: true,
      A__J: [{ a: 1 }],
      A__NULL: null,
    }).load();
    expect(raw['A__N']).toEqual({ value: '5', origin: 'test-override' });
    expect(raw['A__B']?.value).toBe('true');
    expect(raw['A__J']?.value).toBe('[{"a":1}]');
    expect(raw['A__NULL']).toBeUndefined();
  });
});

describe('dotenv dev watch (§5.6)', () => {
  it('reports only CHANGED keys after a file edit, then stops after unsubscribe', async () => {
    write('.env.test', 'LOGGING__LEVEL=info\nAPP__PORT=3000\n');
    const src = new DotenvConfigSource({
      cwd: dir,
      nodeEnv: 'test',
      debounceMs: 20,
    });
    await src.load();

    const seen: Array<Record<string, unknown>> = [];
    const unsubscribe = src.watch((u) => seen.push(u));
    await new Promise((r) => setTimeout(r, 100)); // let the watcher attach
    write('.env.test', 'LOGGING__LEVEL=debug\nAPP__PORT=3000\n');

    const deadline = Date.now() + 5000;
    while (seen.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    expect(seen.length).toBeGreaterThan(0);
    expect(Object.keys(seen[0])).toEqual(['LOGGING__LEVEL']); // APP__PORT unchanged → not reported
    expect((seen[0]['LOGGING__LEVEL'] as { value: string }).value).toBe(
      'debug',
    );

    unsubscribe();
    const count = seen.length;
    write('.env.test', 'LOGGING__LEVEL=error\n');
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBe(count);
  });

  it('only declares dev/test as watchable environments', () => {
    expect(new DotenvConfigSource({ cwd: dir }).watchEnvironments).toEqual([
      'development',
      'test',
    ]);
  });
});

import { parse as dotenvParse } from 'dotenv';
import { findAmbiguousInlineComments } from './dotenv-lint';

/**
 * dotenv's real behavior, pinned. The lint in dotenv-lint.ts exists because of exactly this,
 * and is coupled to this version's tokenizer — if a dotenv bump changes any expectation in the
 * first block, the lint must be re-checked (package.json pins dotenv EXACTLY; this is the second lock).
 */
describe('dotenv semantics the lint depends on (pinned; SPEC-ERRATA.md E-5)', () => {
  it('dotenv silently truncates at ANY "#" in an unquoted value — with or without a space', () => {
    expect(dotenvParse('A=value # comment')).toEqual({ A: 'value' });
    expect(dotenvParse('A=postgres://u:pa#ss@h/db')).toEqual({
      A: 'postgres://u:pa',
    });
    expect(dotenvParse('A=http://h/page#frag')).toEqual({ A: 'http://h/page' });
    expect(dotenvParse('A=#fff')).toEqual({ A: '' });
  });

  it('quotes protect a "#", and a comment after the closing quote is dropped', () => {
    expect(
      dotenvParse('A="pass #word"\nB=\'pass #word\'\nC=`pass #word`'),
    ).toEqual({
      A: 'pass #word',
      B: 'pass #word',
      C: 'pass #word',
    });
    expect(dotenvParse('A="x" # comment')).toEqual({ A: 'x' });
  });

  it('an explicitly empty value is present-but-empty (§5.2)', () => {
    expect(dotenvParse('A=\n')).toEqual({ A: '' });
  });

  it('is exactly the pinned dotenv version (no ^ or ~)', () => {
    const installed = require('dotenv/package.json').version as string;
    const declared = require('../../../../package.json').dependencies
      .dotenv as string;
    expect(declared).toBe(installed);
  });
});

describe('ambiguous-# lint (spec §5.2)', () => {
  const hits = (src: string) =>
    findAmbiguousInlineComments(src).map((h) => `${h.key}@${h.line}`);

  it.each([
    ['inline comment', 'A__X=value # note'],
    ['no space before #', 'A__X=value#note'],
    ['password containing #', 'A__X=pa#ss'],
    ['URL fragment', 'A__X=http://h/p#frag'],
    ['value starting with #', 'A__X=#fff'],
    ['export prefix', 'export A__X=v # c'],
    ['colon separator', 'A__X: v # c'],
  ])('flags %s', (_name, src) => {
    expect(hits(src)).toEqual(['A__X@1']);
  });

  it.each([
    ['comment-only line', '# just a comment\nA__X=1'],
    ['indented comment-only line', '   # indented\nA__X=1'],
    ['double-quoted #', 'A__X="pa#ss"'],
    ['single-quoted #', "A__X='pa #ss'"],
    ['backtick-quoted #', 'A__X=`pa #ss`'],
    ['comment after a closing quote', 'A__X="v" # note'],
    ['empty value', 'A__X='],
    ['no # anywhere', 'A__X=postgres://u:p@h/db?x=1&y=2'],
  ])('does NOT flag %s', (_name, src) => {
    expect(hits(src)).toEqual([]);
  });

  it('reports the right line numbers and only offending keys', () => {
    expect(hits('A=1\n# c\nB=2 # bad\n\nC="ok # fine"\nD=x#y\n')).toEqual([
      'B@3',
      'D@6',
    ]);
  });

  it('regression: a comment-only line AFTER an assignment does not flag that assignment', () => {
    expect(hits('A=1\n# trailing note about A\nB=2')).toEqual([]);
    expect(hits('A=1\n\n\n   # far below\nB=2')).toEqual([]);
  });

  it('regression: blank lines before a key do not shift its reported line number', () => {
    expect(hits('A=1\n\n\n\nB=2 # bad')).toEqual(['B@5']);
  });

  it('a multi-line quoted value is tokenized like dotenv does: nothing inside it is flagged', () => {
    const pem =
      'KEY="-----BEGIN-----\nOTHER=abc # not an assignment\nline#3\n-----END-----"\nA__X=1';
    expect(hits(pem)).toEqual([]);
    expect(hits(pem + '\nB__X=v # bad')).toEqual(['B__X@6']);
  });

  it('handles CRLF files', () => {
    expect(hits('A=1\r\nB=2 # bad\r\n')).toEqual(['B@2']);
  });

  it('never puts a VALUE in the finding (it may be a secret)', () => {
    expect(
      JSON.stringify(findAmbiguousInlineComments('A__X=hunter2#tail')),
    ).not.toContain('hunter2');
  });
});

describe('DotenvConfigSource enforces the lint (spec §5.2)', () => {
  it('fails the (critical) load with file, line and key — and without echoing the value', async () => {
    write('.env', 'A__OK=1\nDB__URL=postgres://u:hunter2#tail@h/db\n');
    const src = new DotenvConfigSource({ cwd: dir, nodeEnv: 'test' });
    const err = await src.load().catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('.env line 2 (DB__URL)');
    expect(err.message).toContain('Quote the value');
    expect(err.message).not.toContain('hunter2');
    expect((await src.health()).healthy).toBe(false);
  });

  it('applies to every layer, not just .env', async () => {
    write('.env.test.local', 'A__X=v # local note\n');
    await expect(
      new DotenvConfigSource({ cwd: dir, nodeEnv: 'test' }).load(),
    ).rejects.toThrow(/\.env\.test\.local line 1 \(A__X\)/);
  });

  it('quoted values with # load fine, exactly as written', async () => {
    write(
      '.env',
      'A__X="pa#ss word"\nA__Y=\'q #r\'\n# a comment line\nA__Z=plain\n',
    );
    const raw = await new DotenvConfigSource({
      cwd: dir,
      nodeEnv: 'test',
    }).load();
    expect(raw['A__X']?.value).toBe('pa#ss word');
    expect(raw['A__Y']?.value).toBe('q #r');
    expect(raw['A__Z']?.value).toBe('plain');
  });

  it('a bad .env aborts Config boot with the aggregate error (critical source)', async () => {
    write('.env', 'APP__NAME=svc # inline\n');
    const { boot } =
      require('../testing/test-utils') as typeof import('../testing/test-utils');
    const err = await boot(
      {},
      { sources: [new DotenvConfigSource({ cwd: dir, nodeEnv: 'test' })] },
    ).catch((e) => e);
    expect(String(err.message)).toContain(
      'config source "dotenv" (critical) failed to load',
    );
    expect(String(err.message)).toContain('APP__NAME');
  });
});
