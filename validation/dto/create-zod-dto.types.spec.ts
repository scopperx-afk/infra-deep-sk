/**
 * Compile-time contract of `ZodDto<T>` / `createZodDto()` / `validate()` — Validation
 * spec §4, §9, §14 ("ZodDto pattern allows type inference").
 *
 * WHY this does not just contain `const x: CreatePostDto = …` lines, as it would in a
 * normal project: this repo's `tsconfig.json` sets `isolatedModules: true`, under which
 * ts-jest runs TRANSPILE-ONLY — a type error in an ordinary spec never fails `npm test`
 * (verified: a spec containing `const n: number = 'x'` passes). `nest build` excludes
 * `*spec.ts` (tsconfig.build.json), so no other script would catch it either. A type
 * assertion written as plain spec code would therefore be decoration, not a test.
 *
 * So the fixtures below are TypeScript SOURCE TEXT, type-checked in memory with the
 * TypeScript compiler API (already a dependency — Errors' and this module's boundary
 * specs use it) against this repo's own compiler options. A correct fixture must produce
 * zero diagnostics; each deliberately wrong fixture must produce its specific diagnostic
 * code, which proves the harness can fail — i.e. that "zero" really means "type-checked
 * and clean".
 *
 * Fixtures are virtual files (never written to disk), so they are invisible to
 * `boundary.spec.ts`'s scan of the real tree.
 */
import path from 'node:path';
import * as ts from 'typescript';

const FIXTURE_DIR = path.join(__dirname, '__type-fixtures__');

/** Shared by every fixture: the spec's own §4 example, imported through the real sources. */
const PRELUDE = `
import { z } from 'zod';
import { createZodDto, type ZodDto } from '../create-zod-dto';
import { validate } from '../../validate';

const CreatePostSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1),
  tags: z.array(z.string()).max(20).default([]),
});
class CreatePostDto extends createZodDto(CreatePostSchema) {}
type Inferred = z.infer<typeof CreatePostSchema>;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
`;

const FIXTURES: Record<string, string> = {
  /** Everything the spec relies on — must type-check with ZERO diagnostics. */
  'ok.ts': `${PRELUDE}
// ZodDto<T> preserves z.infer<T>: the DTO class and the schema's inferred type are structurally interchangeable.
export const mutual: Mutual<CreatePostDto, Inferred> = true;
export const accepted: CreatePostDto = { title: 'x', body: 'y', tags: [] };
export const flowsBack: Inferred = accepted;
// Appendix A: a handler parameter declared as \`dto: CreatePostDto\` sees the parsed fields.
export function handler(dto: CreatePostDto): string { return dto.title + dto.body + dto.tags.length; }
// validate() returns the schema's OUTPUT type, from either the schema or the DTO's own static.
export const parsed: Inferred = validate(CreatePostSchema, {});
export const viaDto: Inferred = validate(CreatePostDto.schema, {});
export const marker: true = CreatePostDto.isZodDto;
export const schemaStatic: ZodDto<Inferred>['schema'] = CreatePostDto.schema;

// Deviation D1 regression: §6's own schema (coerce + default + transform → input !== output)
// failed to compile through the literal \`ZodSchema<T>\` signature (TS2345).
const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  publishedOnly: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
});
class ListPostsQueryDto extends createZodDto(ListPostsQuerySchema) {}
export const q: { page: number; pageSize: number; publishedOnly: boolean } = validate(ListPostsQuerySchema, {});
export const qDto: ListPostsQueryDto = { page: 1, pageSize: 20, publishedOnly: true };
// the DTO type is the transform's OUTPUT (boolean), not the wire type ('true' | 'false')
export const publishedIsBoolean: Mutual<ListPostsQueryDto['publishedOnly'], boolean> = true;

// Known limitation L1's supported shape: a discriminatedUnion nested one level down IS a valid DTO.
const NestedPaymentSchema = z.object({
  payment: z.discriminatedUnion('type', [
    z.object({ type: z.literal('card'), last4: z.string() }),
    z.object({ type: z.literal('bank_transfer'), iban: z.string() }),
  ]),
});
class NestedPaymentDto extends createZodDto(NestedPaymentSchema) {}
export const nestedCard: NestedPaymentDto = { payment: { type: 'card', last4: '4242' } };
`,
  'wrong-field-type.ts': `${PRELUDE}
export const bad: CreatePostDto = { title: 1, body: 'y', tags: [] };
`,
  'missing-required-field.ts': `${PRELUDE}
export const bad: CreatePostDto = { body: 'y', tags: [] };
`,
  /** \`tags\` is optional on the way IN (.default) but required on the DTO: it is the OUTPUT type. */
  'dto-is-output-not-input.ts': `${PRELUDE}
export const bad: CreatePostDto = { title: 'x', body: 'y' };
`,
  'excess-field.ts': `${PRELUDE}
export const bad: CreatePostDto = { title: 'x', body: 'y', tags: [], extra: 1 };
`,
  'is-zod-dto-is-literal-true.ts': `${PRELUDE}
export const bad: false = CreatePostDto.isZodDto;
`,
  /** Known limitation L1: a TOP-LEVEL union cannot be a class base (spec §5 vs §4's \`new (): T\`). */
  'top-level-union-dto.ts': `${PRELUDE}
const PaymentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('card'), last4: z.string() }),
  z.object({ type: z.literal('bank_transfer'), iban: z.string() }),
]);
export class PaymentDto extends createZodDto(PaymentSchema) {}
`,
  'not-a-schema.ts': `${PRELUDE}
export const bad = createZodDto(123);
`,
  'validate-returns-output-type.ts': `${PRELUDE}
export const bad: string = validate(z.number(), 1);
`,
  'validate-rejects-non-schema.ts': `${PRELUDE}
export const bad = validate({}, 1);
`,
};

/**
 * TypeScript normalizes EVERY file name to forward slashes before it reaches a CompilerHost —
 * on Windows too — whereas `path.join()` yields backslashes there. Virtual files must therefore
 * be keyed AND looked up in TypeScript's own form; otherwise the host silently never finds them,
 * the program simply does not contain them, and every test fails with "fixture not part of the
 * program". POSIX never exposes this (its separators already match), which is how it first shipped
 * — the "Windows-style separators" block at the bottom pins it on every platform.
 */
const toPosix = (p: string): string => p.replace(/\\/g, '/');

/** This repo's own compiler options — the point is to check types under THEIR strictness, not a copy. */
function compilerOptions(): ts.CompilerOptions {
  const configPath = ts.findConfigFile(__dirname, (p) => ts.sys.fileExists(p), 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json not found above ' + __dirname);
  const raw = ts.readConfigFile(configPath, (p) => ts.sys.readFile(p));
  const cfg = ts.parseJsonConfigFileContent(raw.config, ts.sys, path.dirname(configPath));
  return {
    ...cfg.options,
    noEmit: true,
    incremental: false, // `incremental: true` needs a tsbuildinfo location we do not want to create
    types: ['node'],
  };
}

/** Builds an in-memory program over `files` (name → source text), placed in `dir`. Nothing touches disk. */
function buildProgram(files: Record<string, string>, dir: string): ts.Program {
  const options = compilerOptions();
  const virtual = new Map(Object.entries(files).map(([name, text]) => [toPosix(path.join(dir, name)), text]));
  const host = ts.createCompilerHost(options, true);
  // `.bind(host)` rather than destructuring: these are prototype-style methods that rely on `this`.
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  const realGetSourceFile = host.getSourceFile.bind(host);
  // TypeScript hands the host forward-slash names (see `toPosix`), so every lookup normalizes first.
  host.fileExists = (f) => virtual.has(toPosix(f)) || realFileExists(f);
  host.readFile = (f) => virtual.get(toPosix(f)) ?? realReadFile(f);
  host.getSourceFile = (f, lang, onError, shouldCreate) => {
    const text = virtual.get(toPosix(f));
    return text !== undefined
      ? ts.createSourceFile(f, text, lang, true)
      : realGetSourceFile(f, lang, onError, shouldCreate);
  };
  return ts.createProgram([...virtual.keys()], options, host);
}

function diagnosticsOf(prog: ts.Program, dir: string, fixture: string): Array<{ code: number; message: string }> {
  const sf = prog.getSourceFile(toPosix(path.join(dir, fixture)));
  if (!sf) throw new Error(`fixture not part of the program: ${fixture}`);
  return ts.getPreEmitDiagnostics(prog, sf).map((d) => ({
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
  }));
}

let program: ts.Program;
const diagnosticsFor = (fixture: string) => diagnosticsOf(program, FIXTURE_DIR, fixture);

beforeAll(() => {
  program = buildProgram(FIXTURES, FIXTURE_DIR);
}, 120_000);

describe('ZodDto<T> / createZodDto() / validate() — compile-time contract', () => {
  it("a correct fixture type-checks with ZERO diagnostics under this repo's own tsconfig", () => {
    expect(diagnosticsFor('ok.ts')).toEqual([]);
  });

  describe('ZodDto<T> preserves z.infer<T> (§4; Appendix A uses `dto: CreatePostDto`)', () => {
    it('rejects a field of the wrong type — TS2322', () => {
      expect(diagnosticsFor('wrong-field-type.ts').map((d) => d.code)).toEqual([2322]);
    });

    it('rejects a missing required field — TS2741', () => {
      expect(diagnosticsFor('missing-required-field.ts').map((d) => d.code)).toEqual([2741]);
    });

    it("the DTO type is the schema's OUTPUT: a `.default()` field is required on the DTO — TS2741", () => {
      expect(diagnosticsFor('dto-is-output-not-input.ts').map((d) => d.code)).toEqual([2741]);
    });

    it('the shape is closed: an excess field is rejected — TS2353', () => {
      expect(diagnosticsFor('excess-field.ts').map((d) => d.code)).toEqual([2353]);
    });

    it('`isZodDto` is the literal `true`, not `boolean` — TS2322', () => {
      expect(diagnosticsFor('is-zod-dto-is-literal-true.ts').map((d) => d.code)).toEqual([2322]);
    });
  });

  describe('createZodDto() and validate() reject what is not a schema', () => {
    it('createZodDto(123) does not compile — TS2345', () => {
      expect(diagnosticsFor('not-a-schema.ts').map((d) => d.code)).toEqual([2345]);
    });

    it('validate({}, 1) does not compile — TS2345', () => {
      expect(diagnosticsFor('validate-rejects-non-schema.ts').map((d) => d.code)).toEqual([2345]);
    });

    it("validate() returns the schema's real output type, not `any` — TS2322 when misused", () => {
      expect(diagnosticsFor('validate-returns-output-type.ts').map((d) => d.code)).toEqual([2322]);
    });
  });

  describe('known limitation L1 — documented, deliberately not worked around', () => {
    it('a TOP-LEVEL discriminatedUnion cannot be a DTO base class — TS2509 (nest it in z.object, as ok.ts does)', () => {
      // If a future change makes this compile, this test fails ON PURPOSE: the spec's §5 vs §4
      // tension has been resolved and the limitation note in create-zod-dto.ts should be removed.
      expect(diagnosticsFor('top-level-union-dto.ts').map((d) => d.code)).toEqual([2509]);
    });
  });
});

describe('Windows-style path separators (regression: every compile-time test failed on Windows)', () => {
  // `path.join(__dirname, …)` on Windows yields backslashes. Replacing `/` with `\` reproduces that
  // shape on any OS (on Windows it is already so), so a POSIX CI run catches this bug too.
  const windowsDir = FIXTURE_DIR.replace(/\//g, '\\');
  let winProgram: ts.Program;

  beforeAll(() => {
    winProgram = buildProgram(
      { 'win-ok.ts': 'export const n: number = 1;\n', 'win-bad.ts': "export const n: number = 'not a number';\n" },
      windowsDir,
    );
  }, 120_000);

  it('virtual fixtures in a backslash-separated directory are found, and a correct one type-checks clean', () => {
    expect(diagnosticsOf(winProgram, windowsDir, 'win-ok.ts')).toEqual([]);
  });

  it('…and are really type-checked, not merely found: a wrong one still reports TS2322', () => {
    expect(diagnosticsOf(winProgram, windowsDir, 'win-bad.ts').map((d) => d.code)).toEqual([2322]);
  });
});
