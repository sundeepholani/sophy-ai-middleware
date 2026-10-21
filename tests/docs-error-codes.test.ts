/**
 * Docs grounding (AGENTS.md: every API claim in /docs is grounded in app/v1, lib/http and
 * the gateway modules they call).
 *
 * - Every named error code an /v1 route or a gateway/http module can return has exactly one
 *   row in the public docs' ERROR_ROWS. The codes are read from the TypeScript AST of the
 *   source, not from a hand-kept list, so a new code without a docs row fails here.
 * - The route lists on /docs and on the landing page match the route files under app/v1.
 * - Links into /docs land on an element that exists.
 *
 * Source is read as text: a Next page module may not export ERROR_ROWS, and importing the
 * pages would pull in React and Next. The parser is the repo's own TypeScript devDependency.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const DOCS_PATH = 'app/(marketing)/docs/page.tsx';
const DOCS = read(DOCS_PATH);
const LANDING = read('app/(marketing)/page.tsx');
const FOOTER = read('components/marketing/site-footer.tsx');

/** Repo-relative paths of the files under `dir` whose name passes `keep`, recursively. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(path, keep));
    else if (keep(entry.name)) found.push(path);
  }
  return found.sort();
}

const isTs = (name: string) => name.endsWith('.ts') && !name.endsWith('.d.ts');
const ROUTE_FILES = filesUnder('app/v1', (name) => name === 'route.ts');
/** Every module that builds client-facing errors for the /v1 routes. */
const API_SOURCES = [...ROUTE_FILES, ...filesUnder('lib/gateway', isTs), ...filesUnder('lib/http', isTs)];
/** The code behind POST /v1/evaluate and POST /v1/extract. */
const NATIVE_SOURCES = [
  'app/v1/evaluate/route.ts',
  'app/v1/extract/route.ts',
  'lib/gateway/assessments.ts',
  'lib/gateway/extraction-parse.ts',
  'lib/gateway/extraction.ts',
  'lib/gateway/image-assets.ts',
  'lib/gateway/upstream-error.ts',
  'lib/gateway/project-provider.ts',
];

/**
 * Every named code the two native routes can return (contract §4.1, §4.2, §2.8). A floor for
 * the AST scan below: each one must be found in the source AND documented, so a renamed
 * error helper cannot make the scan silently find nothing.
 */
const NATIVE_ROUTE_CODES = [
  // shared pipeline
  'missing_api_key', 'invalid_api_key', 'project_gateway_unavailable',
  'rate_limit_exceeded', 'quota_exceeded',
  'upstream_invalid_request', 'insufficient_quota', 'upstream_error',
  // evaluate
  'model_not_evaluation', 'missing_state', 'state_too_large', 'missing_questions',
  'invalid_questions', 'questions_empty', 'too_many_questions', 'invalid_question',
  'missing_instructions', 'unsupported_question_type', 'invalid_criteria',
  'invalid_question_id', 'unsupported_provider_options', 'unsupported_media_field',
  // images (evaluate and extract)
  'assets_not_supported', 'invalid_assets', 'too_many_assets', 'invalid_asset_key',
  'invalid_asset', 'unsupported_asset_format', 'invalid_asset_data',
  'asset_format_mismatch', 'asset_too_large', 'assets_too_large', 'unreferenced_asset',
  // extract
  'model_not_extraction', 'invalid_state', 'missing_fields', 'invalid_fields',
  'fields_empty', 'too_many_fields', 'invalid_field_name', 'unsupported_field_type',
  'invalid_field', 'invalid_reference_date', 'invalid_options',
] as const;

/** An error code is a snake_case word with at least one underscore. */
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
/** Validation helpers whose second argument is the code: bad(message, code, param) and fail(…). */
const CODE_HELPERS = new Set(['bad', 'fail']);

/** The string values an expression can evaluate to, when they are literals. */
function literalValues(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return literalValues(node.expression);
  }
  if (ts.isConditionalExpression(node)) return [...literalValues(node.whenTrue), ...literalValues(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return [...literalValues(node.left), ...literalValues(node.right)];
  }
  return [];
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * The literal error codes a file can emit: `code: 'x'` in an object literal (openAiError
 * options, mapped upstream errors), `readonly code = 'x'` on an error class, and the code
 * argument of bad(…)/fail(…) validation helpers.
 */
function emittedCodes(path: string): Set<string> {
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const codes = new Set<string>();
  const add = (node: ts.Node | undefined) => {
    for (const value of literalValues(node)) if (CODE.test(value)) codes.add(value);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && propertyName(node.name) === 'code') {
      add(node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && CODE_HELPERS.has(node.expression.text)) {
      add(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return codes;
}

function codesIn(paths: readonly string[]): Set<string> {
  return new Set(paths.flatMap((path) => [...emittedCodes(path)]));
}

interface ErrorRow {
  status?: string;
  type?: string;
  code?: string;
  when?: string;
}

/** The ERROR_ROWS literal, read from the page's AST. */
function errorRows(): ErrorRow[] {
  const source = ts.createSourceFile(DOCS_PATH, DOCS, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let rows: ErrorRow[] | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ERROR_ROWS' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      rows = node.initializer.elements.map((element) => {
        const row: Record<string, string> = {};
        if (!ts.isObjectLiteralExpression(element)) return row;
        for (const property of element.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const key = propertyName(property.name);
          const [value] = literalValues(property.initializer);
          if (key && value !== undefined) row[key] = value;
        }
        return row;
      });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!rows) throw new Error(`ERROR_ROWS not found in ${DOCS_PATH}`);
  return rows;
}

/** '/chat/completions', '/evaluate', … for every app/v1/**\/route.ts. */
const ROUTES = ROUTE_FILES.map((path) => path.slice('app/v1'.length, -'/route.ts'.length)).sort();

const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight',
  'Nine', 'Ten', 'Eleven', 'Twelve'];

const matches = (source: string, pattern: RegExp) => [...source.matchAll(pattern)].map((m) => m[1]);

describe('docs ERROR_ROWS', () => {
  const rows = errorRows();
  const documented = rows.map((row) => row.code);
  const nativeCodes = codesIn(NATIVE_SOURCES);

  it('has one complete row per code (rows render with key={row.code})', () => {
    for (const row of rows) {
      expect(row.status).toMatch(/^\d{3}$/);
      expect(row.type).toMatch(/^[a-z_]+$/);
      expect(row.code).toMatch(CODE);
      expect(row.when?.trim()).toBeTruthy();
    }
    expect(new Set(documented).size).toBe(documented.length);
  });

  it.each([...NATIVE_ROUTE_CODES])('documents %s, which the native routes really emit', (code) => {
    expect(nativeCodes).toContain(code);
    expect(documented).toContain(code);
  });

  it('documents every named code a /v1 route or a gateway module can return', () => {
    const emitted = codesIn(API_SOURCES);
    expect(emitted.size).toBeGreaterThanOrEqual(NATIVE_ROUTE_CODES.length);
    expect([...emitted].filter((code) => !documented.includes(code)).sort()).toEqual([]);
  });

  it('describes the 503 for both providers', () => {
    const row = rows.find((r) => r.code === 'project_gateway_unavailable');
    expect(row?.status).toBe('503');
    expect(row?.when).toContain('Vercel AI Gateway');
    expect(row?.when).toContain('Cloudflare Workers AI');
    expect(DOCS).not.toContain('no usable Vercel AI Gateway credential');
  });
});

describe('route lists match app/v1', () => {
  it('finds the nine routes, including /extract', () => {
    // Pinned on purpose: a tenth route must update the landing count and this test together.
    expect(ROUTES).toContain('/extract');
    expect(ROUTES).toHaveLength(9);
  });

  it('lists exactly the routes in the docs API surfaces table', () => {
    const listed = matches(DOCS, /\['(?:GET|POST)', '(\/[^']*)', /g).sort();
    expect(listed).toEqual(ROUTES);
    expect(DOCS).toContain("['POST', '/extract', 'Extraction',");
  });

  it('gives /extract a nav item and a section with the same preview label', () => {
    expect(DOCS).toContain("{ id: 'extract', label: 'Extraction models (preview)' }");
    expect(DOCS).toContain('<Section id="extract" title="Extraction models (preview)">');
  });

  it('counts and lists every route on the landing page', () => {
    expect(LANDING).toContain(`${COUNT_WORDS[ROUTES.length]} supported API routes`);
    const start = LANDING.indexOf('const SURFACES');
    const block = LANDING.slice(start, LANDING.indexOf('] as const;', start));
    expect(matches(block, /path: '([^']+)'/g).sort()).toEqual(ROUTES);
  });
});

describe('links into /docs', () => {
  const ids = new Set(matches(DOCS, /\bid="([a-z0-9-]+)"/g));

  it('point at elements that exist on the docs page', () => {
    const targets = [
      ...matches(DOCS, /\{ id: '([a-z0-9-]+)', label: '/g), // NAV_GROUPS
      ...matches(DOCS, /href="#([a-z0-9-]+)"/g), // in-page links
      ...matches(FOOTER, /['"]\/docs#([a-z0-9-]+)['"]/g),
      ...matches(LANDING, /['"]\/docs#([a-z0-9-]+)['"]/g),
    ];
    expect(targets).toContain('extract');
    expect(targets.filter((id) => !ids.has(id))).toEqual([]);
  });
});
