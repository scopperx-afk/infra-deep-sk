/**
 * Architectural contract tests — Logger spec §37, §43 (anti-patterns). Static AST
 * scans over the module's own source, mirroring config/boundary.spec.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const ROOT = __dirname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

interface Parsed {
  file: string;
  sf: ts.SourceFile;
}
const parsed: Parsed[] = walk(ROOT)
  .filter(
    (f) =>
      f.endsWith('.ts') &&
      !f.endsWith('.spec.ts') &&
      !rel(f).startsWith('testing/'),
  )
  .map((f) => ({
    file: rel(f),
    sf: ts.createSourceFile(
      f,
      readFileSync(f, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
    ),
  }));

function collect(sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const filesWith = (pred: (n: ts.Node) => boolean): string[] =>
  parsed
    .filter((p) => collect(p.sf, pred).length > 0)
    .map((p) => p.file)
    .sort();

const isAccess = (n: ts.Node, obj: string, prop: string): boolean =>
  ts.isPropertyAccessExpression(n) &&
  ts.isIdentifier(n.expression) &&
  n.expression.text === obj &&
  n.name.text === prop;

const moduleSpecifiers = (sf: ts.SourceFile): string[] =>
  collect(
    sf,
    (n) =>
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      !!n.moduleSpecifier,
  ).map(
    (n) =>
      ((n as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral).text,
  );

describe('Logger module boundary contract', () => {
  it('scans the production sources it is meant to scan', () => {
    expect(parsed.length).toBeGreaterThan(15);
    expect(parsed.map((p) => p.file)).toEqual(
      expect.arrayContaining([
        'logger.module.ts',
        'logger.service.ts',
        'index.ts',
      ]),
    );
  });

  it('process.env is accessed only in bootstrap-logger.ts — the one documented pre-Config exception (§28)', () => {
    expect(filesWith((n) => isAccess(n, 'process', 'env'))).toEqual([
      'bootstrap/bootstrap-logger.ts',
    ]);
  });

  it('every ISO-timestamp entry field goes through nowIso() — except emergency-logger.ts, which by design (§27) has zero internal dependencies', () => {
    const readsDateIso = (n: ts.Node): boolean =>
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Date';
    const files = filesWith(readsDateIso);
    expect(files).toEqual(['bootstrap/emergency-logger.ts', 'util/clock.ts']);
  });

  it('Date.now() (duration MEASUREMENT, not entry timestamps) is allowed anywhere — only ISO-string production is centralized', () => {
    // Sanity check that the distinction above is meaningful: Date.now() genuinely appears
    // in more than one legitimate place (decorator, interceptor, middleware, dispatcher).
    const usesDateNow = filesWith((n) => isAccess(n, 'Date', 'now'));
    expect(usesDateNow.length).toBeGreaterThan(1);
  });

  it("Symbol.for() is forbidden — tokens are plain Symbol() (matches Config's and Tracing's own rule)", () => {
    expect(filesWith((n) => isAccess(n, 'Symbol', 'for'))).toEqual([]);
  });

  it('every LOGGER_*/LOG_* DI token is declared in logger.tokens.ts and nowhere else', () => {
    const isTokenDecl = (n: ts.Node): boolean =>
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Symbol' &&
      n.arguments.length > 0 &&
      ts.isStringLiteral(n.arguments[0]) &&
      /^(LOGGER|LOG)_/.test(n.arguments[0].text);
    expect(filesWith(isTokenDecl)).toEqual(['logger.tokens.ts']);
  });

  it('imports nothing outside its own directory except Config, Tracing (Layer 0 siblings) and npm/node packages', () => {
    const offenders: string[] = [];
    for (const p of parsed) {
      for (const spec of moduleSpecifiers(p.sf)) {
        if (!spec.startsWith('.')) continue; // npm/node package — fine
        const target = path.resolve(ROOT, path.dirname(p.file), spec);
        const isWithinLogger =
          target === ROOT || target.startsWith(ROOT + path.sep);
        const isConfigOrTracing =
          /[\\/]infrastructure[\\/](config|tracing)(\/index)?$/.test(target);
        if (!isWithinLogger && !isConfigOrTracing)
          offenders.push(`${p.file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never depends on Metrics or Health — they depend on Logger, not vice versa (Observation Port pattern)', () => {
    const bad = parsed.flatMap((p) =>
      moduleSpecifiers(p.sf)
        .filter((s) => /(metrics|health)/i.test(s))
        .map((s) => `${p.file} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it('index.ts exports the two public tokens and none of the internal ones or implementation classes (§37)', () => {
    const index = parsed.find((p) => p.file === 'index.ts')!;
    const exported = collect(index.sf, (n) => ts.isExportDeclaration(n))
      .flatMap((n) => {
        const clause = (n as ts.ExportDeclaration).exportClause;
        return clause && ts.isNamedExports(clause)
          ? clause.elements.map((e) => e.name.text)
          : [];
      })
      .sort();
    for (const pub of ['LOGGER_SERVICE', 'LOGGER_RUNTIME'])
      expect(exported).toContain(pub);
    for (const internal of [
      'LOGGER_OPTIONS',
      'LOGGER_TRANSPORTS',
      'LOGGER_REDACTOR',
      'LOGGER_SAMPLER',
      'LOGGER_OBSERVATION',
      'LOGGER_DISPATCHERS',
      'LOGGER_LEVEL_HOLDER',
    ]) {
      expect(exported).not.toContain(internal);
    }
    for (const impl of [
      'LoggerServiceImpl',
      'LogRedactor',
      'LogSampler',
      'TransportDispatcher',
      'ConsoleTransport',
      'LoggerObservation',
      'PriorityDropBuffer',
    ]) {
      expect(exported).not.toContain(impl);
    }
    // LOG_FORCE (the raw symbol) must never leak — only forceLog() (§16).
    expect(exported).not.toContain('LOG_FORCE');
    expect(exported).toContain('forceLog');
  });

  it('never creates a Tracing span itself — @LogMethod is explicitly NOT a tracing mechanism (§32)', () => {
    const bad = parsed
      .filter((p) => p.file.includes('log-method'))
      .flatMap((p) => moduleSpecifiers(p.sf).filter((s) => /tracing/i.test(s)));
    expect(bad).toEqual([]);
  });

  it('ILogger has no mutation surface beyond the 7 log methods + child() (§6)', () => {
    const port = parsed.find((p) => p.file === 'logger.port.ts')!;
    const iface = collect(
      port.sf,
      (n) => ts.isInterfaceDeclaration(n) && n.name.text === 'ILogger',
    )[0] as ts.InterfaceDeclaration;
    const members = iface.members
      .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''))
      .filter(Boolean);
    expect(members.sort()).toEqual(
      [
        'audit',
        'child',
        'debug',
        'error',
        'fatal',
        'info',
        'trace',
        'warn',
      ].sort(),
    );
  });
});
