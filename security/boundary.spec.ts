/**
 * Architectural contract tests — Security spec §2, §5.1, §8.3, §15.6, §21, §24, §26 (anti-patterns).
 * Static AST scans over the module's own source, mirroring Errors'/Validation's boundary.spec.ts
 * (same helpers, same `.spec.ts` exclusion, never a regex over source text).
 *
 * POSITIVE CONTROLS (the Validation module's addition, kept): most rules are "assert that
 * nothing matches", and a negative-only AST rule fails silently if its matcher ever stops
 * matching. Every rule is a named predicate in `RULES`, and the control test feeds each one a
 * synthetic snippet that MUST trip it — so "[]" below means "scanned and clean", never
 * "matcher is dead".
 *
 * Rules that enforce spec §24's source-scanning requirements:
 *   - no `process.env` outside Config (§2);
 *   - no `Symbol.for()`, and every `Symbol()` lives in security.tokens.ts (§21, architecture rule 22);
 *   - no `x-forwarded-for` outside `ip/` and `network/trusted-proxy.util.ts` (§8.3 / anti-pattern #12);
 *   - no `===` between secrets — `constantTimeEquals` only (§15.6 / anti-pattern #10);
 *   - every `verifyAgainstAnyProfile()` call carries an explicit `algorithms` allow-list (§5.1);
 *   - no `Math.random()` (anti-pattern #11) and no bare `Date.now()` outside `util/clock.ts`
 *     (architecture rule: injectable clock);
 *   - imports: only `../../config` and `../../logger` leave this module (§2: Config + Logger only);
 *   - no other module imports `SecurityModule`, and none deep-imports past `security/index.ts` (§24).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const ROOT = __dirname;
const INFRA = path.resolve(ROOT, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

interface Parsed {
  /** Path relative to the security module root, '/'-separated (virtual for controls). */
  readonly file: string;
  readonly sf: ts.SourceFile;
}
const parse = (file: string, text: string): Parsed => ({
  file,
  sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true),
});
const rel = (p: string): string => path.relative(ROOT, p).split(path.sep).join('/');

const production: Parsed[] = walk(ROOT)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .map((f) => parse(rel(f), readFileSync(f, 'utf8')));

function collect(sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (pred(n)) out.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const at = (p: Parsed, n: ts.Node): string => {
  const { line } = p.sf.getLineAndCharacterOfPosition(n.getStart(p.sf));
  return `${p.file}:${line + 1}  ${n.getText(p.sf).split('\n')[0]?.slice(0, 90)}`;
};

const isPropertyChain = (n: ts.Node, ...names: string[]): boolean => {
  let cur: ts.Node = n;
  for (let i = names.length - 1; i >= 1; i--) {
    if (!ts.isPropertyAccessExpression(cur) || cur.name.text !== names[i]) return false;
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) && cur.text === names[0];
};

const isCallTo = (n: ts.Node, ...names: string[]): n is ts.CallExpression =>
  ts.isCallExpression(n) && (names.length === 1 ? ts.isIdentifier(n.expression) && n.expression.text === names[0] : isPropertyChain(n.expression, ...names));

// ── secret-comparison rule helpers ───────────────────────────────────────────
const SECRET_NAME_RE = /(secret|signature|hmac|digest|password|nonce|csrftoken|cookietoken|headertoken|apikey)/i;
const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
};
const isBenignOperand = (raw: ts.Expression): boolean => {
  const e = unwrap(raw);
  return (
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    ts.isNumericLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(e) && e.text === 'undefined') ||
    ts.isTypeOfExpression(e) ||
    (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) ||
    (ts.isPropertyAccessExpression(e) && e.name.text === 'length')
  );
};
const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

// ── import rule helpers ──────────────────────────────────────────────────────
const importSpecifiers = (sf: ts.SourceFile): Array<{ node: ts.Node; spec: string; names: string[] }> =>
  collect(sf, (n) => ts.isImportDeclaration(n) || (ts.isExportDeclaration(n) && !!n.moduleSpecifier)).map((n) => {
    const decl = n as ts.ImportDeclaration | ts.ExportDeclaration;
    const spec = (decl.moduleSpecifier as ts.StringLiteral).text;
    const names: string[] = [];
    if (ts.isImportDeclaration(decl)) {
      const nb = decl.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) nb.elements.forEach((e) => names.push((e.propertyName ?? e.name).text));
    } else if (decl.exportClause && ts.isNamedExports(decl.exportClause)) {
      decl.exportClause.elements.forEach((e) => names.push((e.propertyName ?? e.name).text));
    }
    return { node: n, spec, names };
  });

/** Resolves a relative specifier of a security file (virtual path under ROOT) to an absolute path. */
const resolveFrom = (file: string, spec: string): string => path.resolve(ROOT, path.dirname(file), spec);

interface Rule {
  readonly name: string;
  readonly scan: (p: Parsed) => string[];
  /** A snippet that MUST trip the rule; scanned as `controlFile`. */
  readonly control: string;
  readonly controlFile?: string;
}

const ALLOWED_OUTWARD = new Set([path.join(INFRA, 'config'), path.join(INFRA, 'logger')]);

const RULES: Rule[] = [
  {
    name: 'no process.env — configuration comes from Config only (§2)',
    scan: (p) => collect(p.sf, (n) => ts.isPropertyAccessExpression(n) && isPropertyChain(n, 'process', 'env')).map((n) => at(p, n)),
    control: 'const x = process.env.FOO;',
  },
  {
    name: 'no Symbol.for() (architecture rule 22)',
    scan: (p) => collect(p.sf, (n) => isCallTo(n, 'Symbol', 'for')).map((n) => at(p, n)),
    control: "const T = Symbol.for('x');",
  },
  {
    name: 'every Symbol() is declared in security.tokens.ts (§21)',
    scan: (p) => (p.file === 'security.tokens.ts' ? [] : collect(p.sf, (n) => isCallTo(n, 'Symbol')).map((n) => at(p, n))),
    control: "export const TOKEN = Symbol('X');",
    controlFile: 'guards/x.ts',
  },
  {
    name: 'no console.* (use Logger)',
    scan: (p) => collect(p.sf, (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'console').map((n) => at(p, n)),
    control: "console.log('x');",
  },
  {
    name: 'no Math.random() — secure randomness only (anti-pattern #11)',
    scan: (p) => collect(p.sf, (n) => isCallTo(n, 'Math', 'random')).map((n) => at(p, n)),
    control: 'const t = Math.random();',
  },
  {
    name: 'no bare Date.now() / new Date() outside util/clock.ts (injectable clock)',
    scan: (p) =>
      p.file === 'util/clock.ts'
        ? []
        : collect(p.sf, (n) => isCallTo(n, 'Date', 'now') || (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Date')).map((n) => at(p, n)),
    control: 'const t = Date.now();',
    controlFile: 'guards/x.ts',
  },
  {
    name: 'x-forwarded-for appears only under ip/ and network/trusted-proxy.util.ts (§8.3, anti-pattern #12)',
    scan: (p) =>
      p.file.startsWith('ip/') || p.file === 'network/trusted-proxy.util.ts'
        ? []
        : collect(p.sf, (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /x-forwarded-for/i.test(n.text)).map((n) => at(p, n)),
    control: "const ip = req.headers['x-forwarded-for'];",
    controlFile: 'guards/x.ts',
  },
  {
    name: 'no ===/!== between secrets — use constantTimeEquals (§15.6, anti-pattern #10)',
    scan: (p) =>
      collect(
        p.sf,
        (n) =>
          ts.isBinaryExpression(n) &&
          EQUALITY.has(n.operatorToken.kind) &&
          !isBenignOperand(n.left) &&
          !isBenignOperand(n.right) &&
          (SECRET_NAME_RE.test(n.left.getText(p.sf)) || SECRET_NAME_RE.test(n.right.getText(p.sf))),
      ).map((n) => at(p, n)),
    control: 'const ok = providedSignature === expectedSignature;',
  },
  {
    name: 'every verifyAgainstAnyProfile() call passes an explicit `algorithms` allow-list (§5.1)',
    scan: (p) =>
      p.file === 'token/jwt.util.ts'
        ? []
        : collect(p.sf, (n) => isCallTo(n, 'verifyAgainstAnyProfile'))
            .filter((n) => {
              const opts = (n as ts.CallExpression).arguments[2];
              return !(opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((pr) => pr.name && ts.isIdentifier(pr.name) && pr.name.text === 'algorithms'));
            })
            .map((n) => at(p, n)),
    control: 'verifyAgainstAnyProfile(token, profiles, { clockToleranceSeconds: 30 });',
    controlFile: 'guards/x.ts',
  },
  {
    name: 'only ../../config and ../../logger leave this module (§2: Config + Logger are the only dependencies)',
    scan: (p) =>
      importSpecifiers(p.sf)
        .filter(({ spec }) => spec.startsWith('.'))
        .filter(({ spec }) => {
          const abs = resolveFrom(p.file, spec);
          const inside = abs === ROOT || abs.startsWith(ROOT + path.sep);
          return !inside && !ALLOWED_OUTWARD.has(abs);
        })
        .map(({ node }) => at(p, node)),
    control: "import { ValidationModule } from '../../validation';",
    controlFile: 'guards/x.ts',
  },
  {
    name: 'no test-only packages in production code',
    scan: (p) => importSpecifiers(p.sf).filter(({ spec }) => spec === '@nestjs/testing' || spec === 'supertest').map(({ node }) => at(p, node)),
    control: "import { Test } from '@nestjs/testing';",
  },
  {
    name: 'index.ts exports no rate-limit (§7 is Resilience\'s) and no CORS (§10 is HTTP\'s) surface',
    scan: (p) =>
      p.file !== 'index.ts'
        ? []
        : importSpecifiers(p.sf).flatMap(({ node, spec, names }) =>
            [spec, ...names].some((s) => /rate.?limit|cors/i.test(s)) ? [at(p, node)] : [],
          ),
    control: "export { RateLimitGuard } from './rate-limit/rate-limit.guard';",
    controlFile: 'index.ts',
  },
  {
    name: 'AuthGuard is registered globally via APP_GUARD, default-deny (§5.1)',
    scan: (p) => {
      if (p.file !== 'security.module.ts') return [];
      const found = collect(
        p.sf,
        (n) =>
          ts.isObjectLiteralExpression(n) &&
          n.properties.some((pr) => ts.isPropertyAssignment(pr) && pr.name.getText(p.sf) === 'provide' && pr.initializer.getText(p.sf) === 'APP_GUARD') &&
          n.properties.some((pr) => ts.isPropertyAssignment(pr) && pr.name.getText(p.sf) === 'useClass' && pr.initializer.getText(p.sf) === 'AuthGuard'),
      );
      return found.length === 1 ? [] : [`${p.file}: expected exactly one { provide: APP_GUARD, useClass: AuthGuard }, found ${found.length}`];
    },
    // The control is a module file that LACKS the registration — the rule must report it.
    control: 'const providers = [];',
    controlFile: 'security.module.ts',
  },
];

describe('Security module — architectural contracts (§24)', () => {
  it('scans a non-trivial number of production files', () => {
    expect(production.length).toBeGreaterThan(40);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      const findings = production.flatMap((p) => rule.scan(p));
      expect(findings).toEqual([]);
    });
  }

  describe('positive controls — every rule trips on a snippet that violates it', () => {
    for (const rule of RULES) {
      it(`control: ${rule.name}`, () => {
        const findings = rule.scan(parse(rule.controlFile ?? 'guards/x.ts', rule.control));
        expect(findings.length).toBeGreaterThan(0);
      });
    }
    it('the secret-comparison rule does NOT flag benign comparisons (literals, undefined, typeof, .length)', () => {
      const rule = RULES.find((r) => r.name.startsWith('no ==='))!;
      const clean = parse(
        'guards/x.ts',
        "if (signature.length !== 32 || typeof secret !== 'string' || cookieToken === undefined || mode === 'x' || nonce !== null) {}",
      );
      expect(rule.scan(clean)).toEqual([]);
    });
  });

  describe('no other module depends on Security\'s internals (§24)', () => {
    const siblings = readdirSync(INFRA)
      .filter((d) => d !== 'security' && statSync(path.join(INFRA, d)).isDirectory())
      .flatMap((d) => walk(path.join(INFRA, d)))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

    /** Findings: imports from a sibling that reach into security/ other than via its index, or that name SecurityModule. */
    const scanSibling = (file: string, text: string): string[] => {
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
      return importSpecifiers(sf)
        .filter(({ spec }) => spec.startsWith('.'))
        .flatMap(({ node, spec, names }) => {
          const abs = path.resolve(path.dirname(file), spec);
          if (abs !== path.join(INFRA, 'security') && !abs.startsWith(path.join(INFRA, 'security') + path.sep)) return [];
          const out: string[] = [];
          if (abs !== path.join(INFRA, 'security')) out.push(`${path.relative(INFRA, file)}: deep import "${spec}"`);
          if (names.includes('SecurityModule')) out.push(`${path.relative(INFRA, file)}: imports SecurityModule`);
          return out.length ? out : (void node, []);
        });
    };

    it('scans sibling modules', () => {
      expect(siblings.length).toBeGreaterThan(50);
    });
    it('no sibling imports SecurityModule or deep-imports into security/ (plain functions via the index only)', () => {
      expect(siblings.flatMap((f) => scanSibling(f, readFileSync(f, 'utf8')))).toEqual([]);
    });
    it('control: a sibling that imports SecurityModule, or deep-imports, IS flagged', () => {
      const fake = path.join(INFRA, 'http', 'x.ts');
      expect(scanSibling(fake, "import { SecurityModule } from '../security';")).toHaveLength(1);
      expect(scanSibling(fake, "import { AuthGuard } from '../security/guards/auth.guard';")).toHaveLength(1);
      expect(scanSibling(fake, "import { verifySignature } from '../security';")).toEqual([]);
    });
  });
});
