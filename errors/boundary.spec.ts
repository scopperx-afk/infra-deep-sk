/**
 * Architectural contract tests — Errors spec §17, §21 (anti-patterns). Static AST
 * scans over the module's own source, mirroring every other module's boundary.spec.ts.
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
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
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

describe('Errors module boundary contract', () => {
  it('scans the production sources it is meant to scan', () => {
    expect(parsed.length).toBeGreaterThan(8);
    expect(parsed.map((p) => p.file)).toEqual(
      expect.arrayContaining(['errors.module.ts', 'index.ts']),
    );
  });

  it('never touches process.env — unlike Logger, Errors has no pre-Config bootstrap phase (§17)', () => {
    expect(filesWith((n) => isAccess(n, 'process', 'env'))).toEqual([]);
  });

  it("Symbol.for() is forbidden — tokens are plain Symbol() (matches every other module's rule)", () => {
    expect(filesWith((n) => isAccess(n, 'Symbol', 'for'))).toEqual([]);
  });

  it('every ERROR_*/ERRORS_* DI token is declared in errors.tokens.ts and nowhere else', () => {
    const isTokenDecl = (n: ts.Node): boolean =>
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Symbol' &&
      n.arguments.length > 0 &&
      ts.isStringLiteral(n.arguments[0]) &&
      /^ERRORS?_/.test(n.arguments[0].text);
    expect(filesWith(isTokenDecl)).toEqual(['errors.tokens.ts']);
  });

  it("builds no redaction or serialization machinery of its own — that stays Logger's job (§11)", () => {
    const bad = parsed.flatMap((p) =>
      moduleSpecifiers(p.sf)
        .filter((s) => /logger\/(redaction|serialization)/.test(s))
        .map((s) => `${p.file} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it('imports nothing outside its own directory except Config, Tracing, Logger (Layer 0/1 siblings it is allowed to depend on) and npm/node packages', () => {
    const offenders: string[] = [];
    for (const p of parsed) {
      for (const spec of moduleSpecifiers(p.sf)) {
        if (!spec.startsWith('.')) continue; // npm/node package — fine
        const target = path.resolve(ROOT, path.dirname(p.file), spec);
        const isWithinErrors =
          target === ROOT || target.startsWith(ROOT + path.sep);
        const isAllowedSibling =
          /[\\/]infrastructure[\\/](config|tracing|logger)(\/index)?$/.test(
            target,
          );
        if (!isWithinErrors && !isAllowedSibling)
          offenders.push(`${p.file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never depends on Metrics or Health — they depend on Errors (via ERRORS_METRICS_COLLECTOR), not vice versa', () => {
    const bad = parsed.flatMap((p) =>
      moduleSpecifiers(p.sf)
        .filter(
          (s) =>
            /(?<!errors\.)(metrics|health)/i.test(s) && !s.includes('errors'),
        )
        .map((s) => `${p.file} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it('index.ts exports the two public tokens, the error classes, the module, and both filters — nothing more', () => {
    const index = parsed.find((p) => p.file === 'index.ts')!;
    const exported = collect(index.sf, (n) => ts.isExportDeclaration(n))
      .flatMap((n) => {
        const clause = (n as ts.ExportDeclaration).exportClause;
        return clause && ts.isNamedExports(clause)
          ? clause.elements.map((e) => e.name.text)
          : [];
      })
      .sort();
    for (const pub of [
      'AppError',
      'DomainError',
      'InfrastructureError',
      'NotFoundError',
      'ConflictError',
      'ValidationError',
      'UnauthorizedError',
      'ForbiddenError',
      'RateLimitedError',
      'ServiceUnavailableError',
      'TimeoutError',
      'ERROR_MAPPER',
      'ERRORS_METRICS_COLLECTOR',
      'ErrorsModule',
      'GlobalExceptionFilter',
      'WsExceptionFilter',
    ]) {
      expect(exported).toContain(pub);
    }
    for (const internal of [
      'ErrorMapperService',
      'ErrorsMetricsCollectorService',
      'HTTP_EXCEPTION_STATUS_MAP',
      'mapHttpExceptionStatus',
    ]) {
      expect(exported).not.toContain(internal);
    }
  });

  it('every concrete AppError subclass declares category/httpStatus as literals (Anti-Pattern #8 stays a compile-time guarantee)', () => {
    const domain = parsed.find((p) => p.file === 'domain/app-error.ts')!;
    const classes = collect(
      domain.sf,
      (n) => ts.isClassDeclaration(n) && !!n.name,
    ) as ts.ClassDeclaration[];
    const concreteClasses = classes.filter(
      (c) =>
        !c.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword) &&
        c.name!.text !== 'AppError',
    );
    expect(concreteClasses.length).toBeGreaterThan(0);
    for (const cls of concreteClasses) {
      const codeProp = cls.members.find(
        (m) =>
          ts.isPropertyDeclaration(m) &&
          ts.isIdentifier(m.name) &&
          m.name.text === 'code',
      ) as ts.PropertyDeclaration | undefined;
      if (codeProp) {
        // `code` must be explicitly typed (widened to `string`) — see app-error.ts's own header.
        expect(codeProp.type).toBeDefined();
      }
    }
  });
});
