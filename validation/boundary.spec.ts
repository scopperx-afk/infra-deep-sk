/**
 * Architectural contract tests — Validation spec §2, §8, §12, §13, §15 (anti-patterns).
 * Static AST scans over the module's own source, mirroring Errors' boundary.spec.ts
 * (same helpers, same `.spec.ts` exclusion, never a regex over source text).
 *
 * One addition over Errors' version: POSITIVE CONTROLS. Most rules here are "assert
 * that nothing matches", and a negative-only AST rule fails silently if its matcher
 * ever stops matching (a renamed TypeScript node, a typo in a predicate). Each rule is
 * therefore a named predicate in `RULES`, and the control test feeds every one a
 * synthetic snippet that MUST trip it — so "[]" below means "scanned and clean", never
 * "matcher is dead".
 *
 * Why `.spec.ts` files are excluded from the production scan: specs legitimately import
 * `@nestjs/testing`, `supertest` and Errors' own `ZodError`-consuming pieces, none of which
 * the production surface may touch. The ONE rule that also scans specs is the
 * `z.coerce.boolean()` ban (§6, §14) — a test fixture using the footgun would be as much a
 * finding as a production schema using it.
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
const parse = (file: string, text: string): Parsed => ({
  file,
  sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true),
});
const allTs = walk(ROOT).filter((f) => f.endsWith('.ts'));
const parsed: Parsed[] = allTs
  .filter((f) => !f.endsWith('.spec.ts'))
  .map((f) => parse(rel(f), readFileSync(f, 'utf8')));
/** Production sources AND specs — used only by the `z.coerce.boolean()` rule. */
const parsedWithSpecs: Parsed[] = allTs.map((f) =>
  parse(rel(f), readFileSync(f, 'utf8')),
);

function collect(sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const filesWith = (
  pred: (n: ts.Node) => boolean,
  from: Parsed[] = parsed,
): string[] =>
  from
    .filter((p) => collect(p.sf, pred).length > 0)
    .map((p) => p.file)
    .sort();

const isAccess = (n: ts.Node, obj: string, prop: string): boolean =>
  ts.isPropertyAccessExpression(n) &&
  ts.isIdentifier(n.expression) &&
  n.expression.text === obj &&
  n.name.text === prop;

const calleeName = (n: ts.CallExpression): string | undefined =>
  ts.isIdentifier(n.expression)
    ? n.expression.text
    : ts.isPropertyAccessExpression(n.expression)
      ? n.expression.name.text
      : undefined;

/** Every static `import`/`export … from` specifier — Errors' own helper, unchanged. */
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

const SANITIZING_CALLS = new Set([
  'replace',
  'replaceAll',
  'trim',
  'trimStart',
  'trimEnd',
  'escape',
  'sanitize',
]);

/** Named matchers. Each is exercised against a snippet it must trip in the control test below. */
const RULES = {
  processEnv: (n: ts.Node) => isAccess(n, 'process', 'env'),
  symbolFor: (n: ts.Node) => isAccess(n, 'Symbol', 'for'),
  symbolCall: (n: ts.Node) =>
    ts.isCallExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'Symbol',
  tryOrCatch: (n: ts.Node) => ts.isTryStatement(n) || ts.isCatchClause(n),
  safeParse: (n: ts.Node) =>
    ts.isPropertyAccessExpression(n) && /^safeParse(Async)?$/.test(n.name.text),
  parseCall: (n: ts.Node) =>
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'parse',
  validationErrorRef: (n: ts.Node) =>
    ts.isIdentifier(n) && n.text === 'ValidationError',
  consoleUse: (n: ts.Node) => ts.isIdentifier(n) && n.text === 'console',
  loggerRef: (n: ts.Node) =>
    ts.isIdentifier(n) &&
    /^(logger|Logger|ILogger|LOGGER_SERVICE)$/.test(n.text),
  sanitizingCall: (n: ts.Node) =>
    ts.isCallExpression(n) && SANITIZING_CALLS.has(calleeName(n) ?? ''),
  dynamicLoad: (n: ts.Node) =>
    ts.isCallExpression(n) &&
    (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(n.expression) && n.expression.text === 'require')),
  injectRef: (n: ts.Node) =>
    ts.isIdentifier(n) && /^(Inject|Reflector)$/.test(n.text),
  /** `z.coerce.boolean`, `zod.coerce.boolean`, and the destructured `coerce.boolean` — all the same footgun (§6). */
  coerceBoolean: (n: ts.Node) =>
    ts.isPropertyAccessExpression(n) &&
    n.name.text === 'boolean' &&
    ((ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'coerce') ||
      (ts.isIdentifier(n.expression) && n.expression.text === 'coerce')),
} satisfies Record<string, (n: ts.Node) => boolean>;

const CONTROLS: Record<keyof typeof RULES, string> = {
  processEnv: `const x = process.env.FOO;`,
  symbolFor: `const t = Symbol.for('X');`,
  symbolCall: `const t = Symbol('X');`,
  tryOrCatch: `try { run(); } catch (e) { throw e; }`,
  safeParse: `const r = schema.safeParse(v);`,
  parseCall: `const r = schema.parse(v);`,
  validationErrorRef: `throw new ValidationError('x', []);`,
  consoleUse: `console.log('x');`,
  loggerRef: `this.logger.error('x');`,
  sanitizingCall: `const s = value.replace(/</g, '');`,
  dynamicLoad: `const m = require('x');`,
  injectRef: `constructor(@Inject(TOKEN) private readonly dep: Dep) {}`,
  coerceBoolean: `const s = z.coerce.boolean();`,
};

describe('Validation module boundary contract', () => {
  describe('the scanner itself (positive controls)', () => {
    it.each(Object.keys(CONTROLS) as Array<keyof typeof RULES>)(
      'rule "%s" trips on a snippet it is meant to catch',
      (name) => {
        const sf = parse('control.ts', CONTROLS[name]).sf;
        expect(collect(sf, RULES[name]).length).toBeGreaterThan(0);
      },
    );

    it('the coerce.boolean rule does NOT trip on the sanctioned alternatives (§6)', () => {
      const ok = parse(
        'ok.ts',
        `const a = z.enum(['true', 'false']).transform((v) => v === 'true');
         const b = z.coerce.number().int();
         const c = z.boolean();
         const d = z.coerce.date();`,
      ).sf;
      expect(collect(ok, RULES.coerceBoolean)).toEqual([]);
    });

    it('the coerce.boolean rule also trips on the destructured spelling', () => {
      const sf = parse(
        'd.ts',
        `const { coerce } = z; const s = coerce.boolean();`,
      ).sf;
      expect(collect(sf, RULES.coerceBoolean).length).toBeGreaterThan(0);
    });
  });

  describe('structure (§13)', () => {
    it('scans exactly the production tree §13 specifies — nothing missing, nothing extra', () => {
      expect(parsed.map((p) => p.file).sort()).toEqual(
        [
          'dto/create-zod-dto.ts',
          'index.ts',
          'pipes/zod-validation.pipe.ts',
          'schemas/query-schemas.ts', // E-V10 (review): queryBoolean/queryInt
          'testing/route-input-audit.ts', // E-V9 (review): CI audit for unvalidated route inputs
          'validate.ts',
          'validation.module.ts',
          'validation.tokens.ts',
        ].sort(),
      );
    });

    it('has no health/ or metrics/ directory — no adapter, no failure mode beyond a rejected schema (§13)', () => {
      const dirs = readdirSync(ROOT).filter((f) =>
        statSync(path.join(ROOT, f)).isDirectory(),
      );
      expect(dirs).not.toContain('health');
      expect(dirs).not.toContain('metrics');
    });
  });

  describe('zero dependencies (§2)', () => {
    it('imports no project module outside validation/ — Config, Tracing, Logger, Errors, HTTP, Security, API Infrastructure (§2, §8, §10)', () => {
      const offenders: string[] = [];
      for (const p of parsed) {
        for (const spec of moduleSpecifiers(p.sf)) {
          if (!spec.startsWith('.')) continue; // package specifiers are checked by the allowlist test below
          const target = path.resolve(ROOT, path.dirname(p.file), spec);
          if (!(target === ROOT || target.startsWith(ROOT + path.sep)))
            offenders.push(`${p.file} → ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('package imports are limited to @nestjs/common, @nestjs/core and zod — and nothing else, not even node: built-ins', () => {
      const ALLOWED = new Set(['@nestjs/common', '@nestjs/core', 'zod']);
      const offenders = parsed.flatMap((p) =>
        moduleSpecifiers(p.sf)
          .filter((s) => !s.startsWith('.') && !ALLOWED.has(s))
          .map((s) => `${p.file} → ${s}`),
      );
      expect(offenders).toEqual([]);
    });

    it("imports zod from the bare 'zod' entry point — the one Errors' `instanceof ZodError` is checked against (§8)", () => {
      const zodSpecifiers = parsed.flatMap((p) =>
        moduleSpecifiers(p.sf).filter(
          (s) => s === 'zod' || s.startsWith('zod/'),
        ),
      );
      expect(zodSpecifiers.length).toBeGreaterThan(0);
      expect(zodSpecifiers.every((s) => s === 'zod')).toBe(true);
    });

    it('uses no require() or dynamic import() — the static-import scans above would otherwise be bypassable', () => {
      expect(filesWith(RULES.dynamicLoad)).toEqual([]);
    });

    it('never touches process.env — no Config, and no pre-Config bootstrap phase either (§2)', () => {
      expect(filesWith(RULES.processEnv)).toEqual([]);
    });
  });

  describe('tokens (§12)', () => {
    it("Symbol.for() is forbidden — tokens are plain Symbol() (matches every other module's rule)", () => {
      expect(filesWith(RULES.symbolFor)).toEqual([]);
    });

    it('declares no DI token at all — no Symbol() call anywhere in the module', () => {
      expect(filesWith(RULES.symbolCall)).toEqual([]);
    });

    it('validation.tokens.ts is exactly `export {};` — no declarations, no runtime exports', () => {
      const tokens = parsed.find((p) => p.file === 'validation.tokens.ts')!;
      const statements = tokens.sf.statements;
      expect(statements).toHaveLength(1);
      const only = statements[0];
      expect(ts.isExportDeclaration(only)).toBe(true);
      const decl = only as ts.ExportDeclaration;
      expect(decl.moduleSpecifier).toBeUndefined(); // not a re-export of something else
      expect(decl.exportClause && ts.isNamedExports(decl.exportClause)).toBe(
        true,
      );
      expect((decl.exportClause as ts.NamedExports).elements).toHaveLength(0);
    });
  });

  describe('public surface (§12)', () => {
    const exportedNames = (): string[] => {
      const index = parsed.find((p) => p.file === 'index.ts')!;
      return collect(index.sf, (n) => ts.isExportDeclaration(n))
        .flatMap((n) => {
          const clause = (n as ts.ExportDeclaration).exportClause;
          return clause && ts.isNamedExports(clause)
            ? clause.elements.map((e) => e.name.text)
            : [];
        })
        .sort();
    };

    it('index.ts exports exactly the §12 five plus the review additions (E-V10 query coercions, E-V9 route-input audit) — nothing else', () => {
      expect(exportedNames()).toEqual(
        [
          'ValidationModule',
          'ZodDto',
          'ZodValidationPipe',
          'createZodDto',
          'validate',
          // E-V10
          'queryBoolean',
          'queryInt',
          // E-V9
          'findUnvalidatedRouteInputs',
          'assertRouteInputsValidated',
          'RouteInputAuditOptions',
          'UnvalidatedRouteInput',
        ].sort(),
      );
    });

    it('index.ts uses no `export *` — the surface can never grow by accident', () => {
      const index = parsed.find((p) => p.file === 'index.ts')!;
      const wildcard = collect(
        index.sf,
        (n) => ts.isExportDeclaration(n) && !n.exportClause,
      );
      expect(wildcard).toEqual([]);
    });

    it('ZodValidationPipe IS exported — WebSocket gateways must apply it per-gateway with @UsePipes (E-V1, amended §12)', () => {
      // Exported as the SAME class, not a second `WsZodValidationPipe` (§15 #7) — the "builds exactly the
      // classes the spec names" test below still pins that there is only one pipe.
      expect(exportedNames()).toContain('ZodValidationPipe');
    });

    it('the exported Pipe is a value export, not type-only — `@UsePipes(ZodValidationPipe)` needs the class at runtime', () => {
      const index = parsed.find((p) => p.file === 'index.ts')!;
      const valueExports = collect(
        index.sf,
        (n) => ts.isExportDeclaration(n) && !n.isTypeOnly,
      ).flatMap((n) => {
        const clause = (n as ts.ExportDeclaration).exportClause;
        return clause && ts.isNamedExports(clause)
          ? clause.elements.map((e) => e.name.text)
          : [];
      });
      expect(valueExports).toContain('ZodValidationPipe');
    });

    it("the Pipe's class JSDoc carries the per-gateway @UsePipes requirement and the HTTP warning (E-V1, E-V6)", () => {
      const sf = parsed.find(
        (p) => p.file === 'pipes/zod-validation.pipe.ts',
      )!.sf;
      const cls = collect(
        sf,
        (n) => ts.isClassDeclaration(n) && n.name?.text === 'ZodValidationPipe',
      )[0];
      const docs = ts
        .getJSDocCommentsAndTags(cls)
        .map((d) => d.getText(sf))
        .join('\n');
      expect(docs).toContain('@UsePipes(ZodValidationPipe)');
      expect(docs).toMatch(/never on HTTP/i);
    });

    it('ZodDto is exported as a TYPE (isolatedModules: a value re-export of an interface would not compile)', () => {
      const index = parsed.find((p) => p.file === 'index.ts')!;
      const typeOnly = collect(
        index.sf,
        (n) => ts.isExportDeclaration(n) && n.isTypeOnly,
      ).flatMap((n) => {
        const clause = (n as ts.ExportDeclaration).exportClause;
        return clause && ts.isNamedExports(clause)
          ? clause.elements.map((e) => e.name.text)
          : [];
      });
      // ZodDto (§12) + the two audit types added by E-V9 — every type-only export, and nothing else
      expect(typeOnly.sort()).toEqual(['RouteInputAuditOptions', 'UnvalidatedRouteInput', 'ZodDto']);
    });
  });

  describe('the failure path is a raw ZodError (§8, §15 #1)', () => {
    it('never catches anything — no try/catch anywhere, so a ZodError cannot be swallowed or rewrapped', () => {
      expect(filesWith(RULES.tryOrCatch)).toEqual([]);
    });

    it('never uses safeParse — only `.parse()`, which throws the ZodError Zod itself constructs', () => {
      expect(filesWith(RULES.safeParse)).toEqual([]);
    });

    it('`.parse()` is called in exactly two places — the Pipe and validate() — one failure contract, not three (§9)', () => {
      expect(filesWith(RULES.parseCall)).toEqual([
        'pipes/zod-validation.pipe.ts',
        'validate.ts',
      ]);
    });

    it("never references Errors' ValidationError — wrapping would need the forbidden lateral import (§8)", () => {
      expect(filesWith(RULES.validationErrorRef)).toEqual([]);
    });
  });

  describe('shape only, and silent (§7, §15 #4, #8)', () => {
    it('never logs — no console use, no Logger reference; Errors’ filter logs every caught exception exactly once (§15 #8)', () => {
      expect(filesWith(RULES.consoleUse)).toEqual([]);
      expect(filesWith(RULES.loggerRef)).toEqual([]);
    });

    it('never strips, escapes or otherwise mutates a string for safety (§15 #4)', () => {
      expect(filesWith(RULES.sanitizingCall)).toEqual([]);
    });
  });

  describe('Pipe and Module shape (§4, §10, §15 #7)', () => {
    const classNamed = (file: string, name: string): ts.ClassDeclaration => {
      const sf = parsed.find((p) => p.file === file)!.sf;
      return collect(
        sf,
        (n) => ts.isClassDeclaration(n) && n.name?.text === name,
      )[0] as ts.ClassDeclaration;
    };
    const decoratorNames = (cls: ts.ClassDeclaration): string[] =>
      (ts.getDecorators(cls) ?? []).map((d) => {
        const e = d.expression;
        return ts.isCallExpression(e) && ts.isIdentifier(e.expression)
          ? e.expression.text
          : ts.isIdentifier(e)
            ? e.text
            : '?';
      });

    it('builds exactly the classes the spec names — no WsZodValidationPipe, no second pipe (§15 #7)', () => {
      const names = parsed.flatMap((p) =>
        collect(p.sf, (n) => ts.isClassDeclaration(n) && !!n.name).map(
          (n) => (n as ts.ClassDeclaration).name!.text,
        ),
      );
      expect(names.sort()).toEqual([
        'AugmentedZodDto',
        'ValidationModule',
        'ZodValidationPipe',
      ]);
    });

    it('ZodValidationPipe declares no constructor and uses no @Inject/Reflector — no constructor dependencies (§4)', () => {
      const pipe = classNamed(
        'pipes/zod-validation.pipe.ts',
        'ZodValidationPipe',
      );
      expect(pipe.members.filter(ts.isConstructorDeclaration)).toEqual([]);
      expect(filesWith(RULES.injectRef)).toEqual([]);
    });

    it('ZodValidationPipe is decorated @Injectable() only', () => {
      expect(
        decoratorNames(
          classNamed('pipes/zod-validation.pipe.ts', 'ZodValidationPipe'),
        ),
      ).toEqual(['Injectable']);
    });

    it('ValidationModule has no forRoot()/forFeature() — nothing per-consumer to register (§10)', () => {
      const mod = classNamed('validation.module.ts', 'ValidationModule');
      const statics = mod.members
        .filter(
          (m) =>
            ts.isMethodDeclaration(m) &&
            m.modifiers?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword),
        )
        .map((m) => ((m as ts.MethodDeclaration).name as ts.Identifier).text);
      expect(statics).toEqual([]);
    });

    it('ValidationModule is a plain @Module() — not @Global(), and its metadata is `providers` alone (§10)', () => {
      const mod = classNamed('validation.module.ts', 'ValidationModule');
      expect(decoratorNames(mod)).toEqual(['Module']);
      const call = (ts.getDecorators(mod) ?? [])[0]
        .expression as ts.CallExpression;
      const meta = call.arguments[0] as ts.ObjectLiteralExpression;
      expect(
        meta.properties.map((p) => (p.name as ts.Identifier).text),
      ).toEqual(['providers']);
    });

    it('ValidationModule registers the Pipe through the APP_PIPE framework token — never by importing a sibling (§10)', () => {
      const sf = parsed.find((p) => p.file === 'validation.module.ts')!.sf;
      const usesAppPipe = collect(
        sf,
        (n) => ts.isIdentifier(n) && n.text === 'APP_PIPE',
      );
      expect(usesAppPipe.length).toBeGreaterThan(0);
    });
  });

  describe('z.coerce.boolean() is banned project-wide (§6, §14)', () => {
    it('no schema anywhere under validation/ — production OR spec — uses it', () => {
      expect(filesWith(RULES.coerceBoolean, parsedWithSpecs)).toEqual([]);
    });
  });
});
