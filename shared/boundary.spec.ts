/**
 * Architectural contract for `infrastructure/shared` (Resilience spec §6.2, Database spec §8).
 *
 * `shared/` is plain, stateless code that Layer 2 AND Layer 3 modules both import, so it must
 * not be able to create a dependency problem for any of them. Static AST scans, each rule with
 * a POSITIVE CONTROL (a snippet that must trip it) so a dead matcher cannot pass silently —
 * the pattern Errors', Validation's and Security's boundary specs use.
 *
 *   - imports: only files inside `shared/`, `../config` (Layer 0 public index) and `zod`; the
 *     one `../logger` import is TYPE-ONLY (the logger shape, zero runtime coupling);
 *   - stateless: no top-level `let`/`var`, no classes holding mutable module state;
 *   - no `process.env`, no `console.*`, no `Symbol()` tokens (it is not a Nest module);
 *   - no `Date.now()` CALL (a reference as an injectable default is how the clock is wired);
 *   - `Math.random` only in `computeBackoff.ts`, and only as an injectable default;
 *   - timers (`setTimeout`/`setInterval`) only in `connect-with-retry.ts`, which owns and
 *     always clears them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const ROOT = __dirname;
const INFRA = path.resolve(ROOT, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

interface Parsed { readonly file: string; readonly sf: ts.SourceFile }
const parse = (file: string, text: string): Parsed => ({ file, sf: ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true) });
const production: Parsed[] = walk(ROOT)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
  .map((f) => parse(path.relative(ROOT, f).split(path.sep).join('/'), readFileSync(f, 'utf8')));

const collect = (sf: ts.SourceFile, pred: (n: ts.Node) => boolean): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => { if (pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(sf);
  return out;
};
const at = (p: Parsed, n: ts.Node): string => `${p.file}:${p.sf.getLineAndCharacterOfPosition(n.getStart(p.sf)).line + 1}  ${n.getText(p.sf).split('\n')[0]?.slice(0, 80)}`;

const isMember = (n: ts.Node, obj: string, prop: string): boolean =>
  ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === obj && n.name.text === prop;
const isCall = (n: ts.Node, name: string): boolean => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name;

interface Rule { readonly name: string; readonly scan: (p: Parsed) => string[]; readonly control: string; readonly controlFile?: string }

const RULES: Rule[] = [
  {
    name: 'imports: only shared/ files, ../config, zod — and ../logger strictly as `import type`',
    scan: (p) =>
      collect(p.sf, (n) => ts.isImportDeclaration(n) || (ts.isExportDeclaration(n) && !!n.moduleSpecifier))
        .filter((n) => {
          const decl = n as ts.ImportDeclaration | ts.ExportDeclaration;
          const spec = (decl.moduleSpecifier as ts.StringLiteral).text;
          if (spec === 'zod') return false;
          if (!spec.startsWith('.')) return true; // any other package
          if (spec === '../config') return false;
          if (spec === '../logger') return !(ts.isImportDeclaration(decl) && decl.importClause?.isTypeOnly === true);
          return !path.resolve(ROOT, path.dirname(p.file), spec).startsWith(ROOT); // anything else leaving shared/
        })
        .map((n) => at(p, n)),
    control: "import { LoggerModule } from '../logger'; import { X } from '../errors'; import axios from 'axios';",
  },
  {
    name: 'stateless: no top-level let/var',
    scan: (p) =>
      p.sf.statements
        .filter((s): s is ts.VariableStatement => ts.isVariableStatement(s) && !(s.declarationList.flags & ts.NodeFlags.Const))
        .map((s) => at(p, s)),
    control: 'let cache = new Map();',
  },
  { name: 'no process.env', scan: (p) => collect(p.sf, (n) => ts.isPropertyAccessExpression(n) && isMember(n.expression, 'process', 'env')).map((n) => at(p, n)), control: 'const x = process.env.A;' },
  { name: 'no console.*', scan: (p) => collect(p.sf, (n) => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'console').map((n) => at(p, n)), control: "console.log('x');" },
  { name: 'no Symbol() — shared/ is not a DI module', scan: (p) => collect(p.sf, (n) => isCall(n, 'Symbol')).map((n) => at(p, n)), control: "const T = Symbol('x');" },
  {
    name: 'no Date.now() CALL — the clock is an injectable `now` whose default is the Date.now REFERENCE',
    scan: (p) => collect(p.sf, (n) => ts.isCallExpression(n) && isMember(n.expression, 'Date', 'now')).map((n) => at(p, n)),
    control: 'const t = Date.now();',
  },
  {
    name: 'Math.random only in computeBackoff.ts',
    scan: (p) => (p.file === 'computeBackoff.ts' ? [] : collect(p.sf, (n) => isMember(n, 'Math', 'random')).map((n) => at(p, n))),
    control: 'const r = Math.random();',
    controlFile: 'connect-with-retry.ts',
  },
  {
    name: 'timers only in connect-with-retry.ts (which clears every one it sets)',
    scan: (p) => (p.file === 'connect-with-retry.ts' ? [] : collect(p.sf, (n) => isCall(n, 'setTimeout') || isCall(n, 'setInterval')).map((n) => at(p, n))),
    control: 'setTimeout(() => undefined, 5);',
    controlFile: 'computeBackoff.ts',
  },
];

describe('infrastructure/shared — architectural contracts', () => {
  it('scans every production file', () => {
    expect(production.map((p) => p.file).sort()).toEqual(
      ['computeBackoff.ts', 'connect-retry.schema.ts', 'connect-with-retry.ts', 'index.ts', 'transient-network-error.ts'],
    );
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      expect(production.flatMap((p) => rule.scan(p))).toEqual([]);
    });
    it(`control: ${rule.name}`, () => {
      expect(rule.scan(parse(rule.controlFile ?? 'x.ts', rule.control)).length).toBeGreaterThan(0);
    });
  }

  it('every setTimeout in connect-with-retry.ts has a matching clearTimeout (no leaked timer keeps boot alive)', () => {
    const file = production.find((p) => p.file === 'connect-with-retry.ts')!;
    const sets = collect(file.sf, (n) => isCall(n, 'setTimeout')).length;
    const clears = collect(file.sf, (n) => isCall(n, 'clearTimeout')).length;
    expect(sets).toBeGreaterThan(0);
    expect(clears).toBeGreaterThanOrEqual(sets);
  });

  it('the spec-mandated file names exist exactly (Resilience/Events/Queue import these paths directly)', () => {
    for (const f of ['computeBackoff.ts', 'connect-with-retry.ts']) expect(readdirSync(ROOT)).toContain(f);
  });

  it('no existing module has started depending on a private path of shared/ other than the two spec-named files or the index', () => {
    const allowedTargets = new Set([path.join(INFRA, 'shared'), path.join(INFRA, 'shared', 'computeBackoff'), path.join(INFRA, 'shared', 'connect-with-retry')]);
    const offenders = readdirSync(INFRA)
      .filter((d) => d !== 'shared' && statSync(path.join(INFRA, d)).isDirectory())
      .flatMap((d) => walk(path.join(INFRA, d)))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .flatMap((f) => {
        const sf = ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ES2022, true);
        return collect(sf, (n) => ts.isImportDeclaration(n) || ts.isExportDeclaration(n))
          .map((n) => (n as ts.ImportDeclaration).moduleSpecifier)
          .filter((m): m is ts.StringLiteral => !!m && ts.isStringLiteral(m) && m.text.startsWith('.'))
          .map((m) => path.resolve(path.dirname(f), m.text))
          .filter((abs) => abs.startsWith(path.join(INFRA, 'shared')) && !allowedTargets.has(abs))
          .map((abs) => `${path.relative(INFRA, f)} → ${path.relative(INFRA, abs)}`);
      });
    expect(offenders).toEqual([]);
  });
});
