/**
 * Architectural contract tests — Config spec §17.7, §21 checklist.
 *
 * These scan the module's own source through the TypeScript AST (not regexes), so a
 * mention inside a comment or a string literal — e.g. the origin label 'process.env' —
 * is never mistaken for real access.
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

/** Files (sorted) containing at least one node matching `pred`. */
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

describe('module boundary contract', () => {
  it('scans the production sources it is meant to scan', () => {
    expect(parsed.length).toBeGreaterThan(20);
    expect(parsed.map((p) => p.file)).toEqual(
      expect.arrayContaining([
        'config.module.ts',
        'config.initializer.ts',
        'index.ts',
      ]),
    );
  });

  it('process.env is ACCESSED only by the module’s own source adapters (Anti-Pattern #1)', () => {
    expect(filesWith((n) => isAccess(n, 'process', 'env'))).toEqual([
      'sources/dotenv.source.ts',
      'sources/env.source.ts',
    ]);
  });

  it('dotenv.config() is never called — only dotenv.parse() is imported (§5.2)', () => {
    expect(filesWith((n) => isAccess(n, 'dotenv', 'config'))).toEqual([]);
    const named = parsed.flatMap((p) =>
      collect(
        p.sf,
        (n) =>
          ts.isImportDeclaration(n) &&
          (n.moduleSpecifier as ts.StringLiteral).text === 'dotenv',
      ).flatMap((n) => {
        const clause = (n as ts.ImportDeclaration).importClause;
        const bindings = clause?.namedBindings;
        const names =
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements.map((e) => (e.propertyName ?? e.name).text)
            : [];
        return [...(clause?.name ? ['<default>'] : []), ...names];
      }),
    );
    expect(named).toEqual(['parse']);
  });

  it('process.exit is called at exactly one site (§17.7)', () => {
    const files = parsed.filter(
      (p) => collect(p.sf, (n) => isAccess(n, 'process', 'exit')).length > 0,
    );
    expect(files.map((p) => p.file)).toEqual(['config.initializer.ts']);
    expect(
      collect(files[0].sf, (n) => isAccess(n, 'process', 'exit')),
    ).toHaveLength(1);
  });

  it('Symbol.for() is forbidden — tokens are plain Symbol() (architecture rule 22)', () => {
    expect(filesWith((n) => isAccess(n, 'Symbol', 'for'))).toEqual([]);
  });

  it('every CONFIG_*/SECRET_* DI token is declared in config.tokens.ts and nowhere else', () => {
    const isTokenDecl = (n: ts.Node): boolean =>
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'Symbol' &&
      n.arguments.length > 0 &&
      ts.isStringLiteral(n.arguments[0]) &&
      /^(CONFIG|SECRET)_/.test(n.arguments[0].text);
    expect(filesWith(isTokenDecl)).toEqual(['config.tokens.ts']);
  });

  it('the system clock is read in exactly one place (architecture rule 20)', () => {
    const readsClock = (n: ts.Node): boolean =>
      isAccess(n, 'Date', 'now') ||
      isAccess(n, 'performance', 'now') ||
      (ts.isNewExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'Date');
    expect(filesWith(readsClock)).toEqual(['util/clock.ts']);
  });

  it('imports nothing outside its own directory except npm/node packages (Layer 0: no upward or sideways deps)', () => {
    const offenders: string[] = [];
    for (const p of parsed) {
      for (const spec of moduleSpecifiers(p.sf)) {
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(ROOT, path.dirname(p.file), spec);
        if (target !== ROOT && !target.startsWith(ROOT + path.sep))
          offenders.push(`${p.file} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never depends on Logger / Tracing / Metrics / Health — they depend on Config, not vice versa (§17.1)', () => {
    const bad = parsed.flatMap((p) =>
      moduleSpecifiers(p.sf)
        .filter((s) => /(logger|tracing|metrics|health)/i.test(s))
        .map((s) => `${p.file} → ${s}`),
    );
    expect(bad).toEqual([]);
  });

  it('inspects Zod internals (._def) ONLY for path enumeration — never to classify secrets (§7.5, Anti-Pattern #11)', () => {
    const readsDef = (n: ts.Node): boolean =>
      ts.isPropertyAccessExpression(n) && n.name.text === '_def';
    expect(filesWith(readsDef)).toEqual(['schema/schema-paths.ts']);

    // …and that one file must not even know about secrets (checked on identifiers, not comments).
    const walker = parsed.find((p) => p.file === 'schema/schema-paths.ts')!;
    const secretish = collect(
      walker.sf,
      (n) => ts.isIdentifier(n) && /secret/i.test(n.text),
    );
    expect(secretish).toHaveLength(0);
  });

  it('index.ts exports the three public tokens and NONE of the internal ones or implementation classes (§4)', () => {
    const index = parsed.find((p) => p.file === 'index.ts')!;
    const exported = collect(index.sf, (n) => ts.isExportDeclaration(n))
      .flatMap((n) => {
        const clause = (n as ts.ExportDeclaration).exportClause;
        return clause && ts.isNamedExports(clause)
          ? clause.elements.map((e) => e.name.text)
          : [];
      })
      .sort();

    for (const pub of ['CONFIG_SERVICE', 'CONFIG_REGISTRY', 'CONFIG_OPTIONS'])
      expect(exported).toContain(pub);
    for (const internal of [
      'CONFIG_SOURCES',
      'CONFIG_INITIALIZER',
      'CONFIG_LOADER',
      'CONFIG_VALIDATOR',
      'CONFIG_STORE',
      'SECRET_RESOLVER',
      'CONFIG_OBSERVATION',
      'CONFIG_NOTIFIER',
      'CONFIG_LISTENERS',
    ]) {
      expect(exported).not.toContain(internal);
    }
    for (const impl of [
      'ConfigServiceImpl',
      'ConfigRegistryImpl',
      'ConfigLoader',
      'ConfigValidator',
      'ConfigStore',
      'EnvironmentConfigSource',
      'DotenvConfigSource',
    ]) {
      expect(exported).not.toContain(impl);
    }
  });

  it('ConfigService has no mutation / dump / inspect surface (§3.1, §9.3)', () => {
    const port = parsed.find((p) => p.file === 'config.port.ts')!;
    const iface = collect(
      port.sf,
      (n) => ts.isInterfaceDeclaration(n) && n.name.text === 'ConfigService',
    )[0] as ts.InterfaceDeclaration;
    const members = iface.members
      .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ''))
      .filter(Boolean);
    expect(members).toEqual(
      expect.arrayContaining([
        'get',
        'has',
        'getNamespace',
        'isProduction',
        'getEnvironment',
        'onChange',
        'onNamespaceChange',
        'getConfigReport',
        'getHealth',
        'getMetricsSnapshot',
      ]),
    );
    for (const banned of [
      'set',
      'dump',
      'inspect',
      'reload',
      'update',
      'delete',
    ])
      expect(members).not.toContain(banned);
  });
});
