#!/usr/bin/env node
/**
 * Readability metrics for src/ and scripts/ (TypeScript/TSX), using the TypeScript compiler API.
 *
 * Usage (from the repo root; in Git Bash use node.exe, especially with redirected/background output):
 *   node.exe scripts/readability-metrics.cjs              # summary + top lists
 *   node.exe scripts/readability-metrics.cjs --top 25     # longer top lists
 *   node.exe scripts/readability-metrics.cjs --match auditWorkerRunConsistency   # functions whose name or file matches
 *   node.exe scripts/readability-metrics.cjs --json  # raw JSON on stdout; does not write files
 *
 * Definitions:
 *   - lines: physical lines from the function's first token to its closing brace.
 *   - complexity: 1 + if / ?: / for / for-in / for-of / while / do / case / catch / && / || / ?? (nested functions excluded).
 *   - depth: deepest nesting of if/loop/switch/try inside the function; `else if` does not add a level.
 *   - comment ratio: comment-only lines divided by lines that contain code.
 *   - fan-in: number of production modules under src/ that import the module (static, re-export and dynamic
 *     imports; relative and "@/" specifiers resolved to .ts/.tsx/index files).
 * Test files (*.test.ts[x], *testFixtures*) are reported separately and excluded from the headline numbers.
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const root = process.cwd();
const top = Number(opt('--top', '15'));
const match = opt('--match', '');
// `--json` prints the raw metrics JSON. A trailing path-shaped argument (the previous
// `--json <path>` form) is ignored: JSON now always goes to stdout and writes no file.
const jsonOutput = args.includes('--json');
const ts = require(path.join(root, 'node_modules', 'typescript'));

const CJK = /[一-鿿]/;
function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p, acc); }
    else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

const files = walk(path.join(root, 'src'), []).concat(walk(path.join(root, 'scripts'), []));
const fileStats = [];
const fnStats = [];
const hatches = { prod: { any: 0, asAny: 0, doubleAssert: 0, nonNull: 0, tsIgnore: 0, tsExpectError: 0, eslintDisable: 0 } };
hatches.test = { ...hatches.prod };

const fnKinds = new Set([ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor, ts.SyntaxKind.ArrowFunction, ts.SyntaxKind.FunctionExpression]);
const decisionKinds = new Set([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ConditionalExpression, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause, ts.SyntaxKind.CaseClause]);
const nestKinds = new Set([ts.SyntaxKind.IfStatement, ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement]);
const logicalOps = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const isTest = /\.test\.(ts|tsx)$/.test(rel) || /testFixtures/.test(rel);
  const H = isTest ? hatches.test : hatches.prod;
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;

  const comments = new Map();
  const collect = (ranges) => { for (const r of ranges || []) comments.set(r.pos, r); };
  const visitComments = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(sf)) visitComments(child);
  };
  visitComments(sf);
  const masked = text.split('');
  let cjkComments = 0;
  for (const r of comments.values()) {
    const c = text.slice(r.pos, r.end);
    if (CJK.test(c)) cjkComments++;
    if (/@ts-ignore/.test(c)) H.tsIgnore++;
    if (/@ts-expect-error/.test(c)) H.tsExpectError++;
    if (/eslint-disable/.test(c)) H.eslintDisable++;
    for (let i = r.pos; i < r.end; i++) if (masked[i] !== '\n') masked[i] = ' ';
  }
  const lines = text.split('\n');
  const maskedLines = masked.join('').split('\n');
  let code = 0, commentOnly = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (maskedLines[i].trim()) code++; else commentOnly++;
  }

  let exported = 0, exportedWithDoc = 0;
  const fnName = (n) => {
    if (n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name) || ts.isPrivateIdentifier(n.name))) return n.name.text;
    if (n.kind === ts.SyntaxKind.Constructor) return 'constructor';
    const p = n.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p) && p.name && 'text' in p.name) return p.name.text;
    if (p && ts.isCallExpression(p)) return `<callback of ${p.expression.getText(sf).slice(0, 40)}>`;
    return '<anonymous>';
  };
  const analyzeFn = (fn) => {
    let complexity = 1, depthMax = 0;
    const walkFn = (n, depth) => {
      if (n !== fn && fnKinds.has(n.kind)) return;
      if (decisionKinds.has(n.kind)) complexity++;
      if (ts.isBinaryExpression(n) && logicalOps.has(n.operatorToken.kind)) complexity++;
      const isElseIf = n.kind === ts.SyntaxKind.IfStatement && ts.isIfStatement(n.parent) && n.parent.elseStatement === n;
      let d = depth;
      if (nestKinds.has(n.kind) && !isElseIf) { d = depth + 1; depthMax = Math.max(depthMax, d); }
      ts.forEachChild(n, (c) => walkFn(c, d));
    };
    walkFn(fn.body, 0);
    const start = lineOf(fn.getStart(sf));
    fnStats.push({ file: rel, name: fnName(fn), line: start + 1, lines: lineOf(fn.end) - start + 1, complexity,
      depth: depthMax, params: fn.parameters ? fn.parameters.length : 0, isTest });
  };
  const visit = (n) => {
    if (fnKinds.has(n.kind) && n.body) analyzeFn(n);
    if (n.kind === ts.SyntaxKind.AnyKeyword) H.any++;
    if (ts.isAsExpression(n)) {
      if (n.type.kind === ts.SyntaxKind.AnyKeyword) H.asAny++;
      if (ts.isAsExpression(n.expression) && n.expression.type.kind === ts.SyntaxKind.UnknownKeyword) H.doubleAssert++;
    }
    if (n.kind === ts.SyntaxKind.NonNullExpression) H.nonNull++;
    if (n.parent === sf && (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableStatement(n)
      || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n))
      && (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export)) {
      exported++;
      if (n.jsDoc && n.jsDoc.length > 0) exportedWithDoc++;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  fileStats.push({ file: rel, isTest, lines: lines.length, code, commentOnly, comments: comments.size, cjkComments, exported, exportedWithDoc });
}

// Import fan-in among production modules under src/.
const srcRoot = path.join(root, 'src');
const inSrc = (p) => p.startsWith(srcRoot + path.sep);
const isTestPath = (p) => /\.test\.(ts|tsx)$/.test(p) || /testFixtures/.test(p);
const knownFiles = new Set(files.filter(inSrc));
const SPEC = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const resolveSpec = (from, spec) => {
  let base;
  if (spec.startsWith('@/')) base = path.join(srcRoot, spec.slice(2));
  else if (spec.startsWith('.')) base = path.normalize(path.join(path.dirname(from), spec));
  else return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (knownFiles.has(c)) return c;
  }
  return null;
};
const fanIn = new Map();
for (const file of knownFiles) {
  if (isTestPath(file)) continue;
  const targets = new Set();
  for (const m of fs.readFileSync(file, 'utf8').matchAll(SPEC)) {
    const t = resolveSpec(file, m[1] || m[2]);
    if (t && t !== file && !isTestPath(t)) targets.add(t);
  }
  for (const t of targets) {
    const key = path.relative(root, t).replace(/\\/g, '/');
    fanIn.set(key, (fanIn.get(key) || 0) + 1);
  }
}

const pct = (values, p) => {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return 0;
  return v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))];
};
const prodFiles = fileStats.filter((f) => !f.isTest);
const testFiles = fileStats.filter((f) => f.isTest);
const prodFns = fnStats.filter((f) => !f.isTest);
const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
const ratio = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : 'n/a');

if (!jsonOutput && match) {
  console.log(`| function | file:line | lines | complexity | depth | params |\n| --- | --- | --- | --- | --- | --- |`);
  for (const f of fnStats.filter((x) => x.name.includes(match) || x.file.includes(match)).sort((a, b) => b.lines - a.lines)) {
    console.log(`| ${f.name} | ${f.file}:${f.line} | ${f.lines} | ${f.complexity} | ${f.depth} | ${f.params} |`);
  }
} else if (!jsonOutput) {
  const fileLines = prodFiles.map((f) => f.lines);
  const fnLines = prodFns.map((f) => f.lines);
  const fnCx = prodFns.map((f) => f.complexity);
  console.log('# Readability metrics\n');
  console.log(`- production: ${prodFiles.length} files, ${sum(prodFiles, 'lines')} lines; tests: ${testFiles.length} files, ${sum(testFiles, 'lines')} lines`);
  console.log(`- file lines p50 ${pct(fileLines, 0.5)}, p90 ${pct(fileLines, 0.9)}, max ${Math.max(...fileLines)}; >400: ${fileLines.filter((x) => x > 400).length}, >600: ${fileLines.filter((x) => x > 600).length}, >1000: ${fileLines.filter((x) => x > 1000).length}`);
  console.log(`- functions ${prodFns.length}: lines p90 ${pct(fnLines, 0.9)}, p99 ${pct(fnLines, 0.99)}; >100 lines: ${fnLines.filter((x) => x > 100).length}; >300 lines: ${fnLines.filter((x) => x > 300).length}`);
  console.log(`- complexity p90 ${pct(fnCx, 0.9)}, p99 ${pct(fnCx, 0.99)}; >20: ${fnCx.filter((x) => x > 20).length}; >50: ${fnCx.filter((x) => x > 50).length}; depth >=4: ${prodFns.filter((f) => f.depth >= 4).length}; params >=6: ${prodFns.filter((f) => f.params >= 6).length}`);
  console.log(`- comment-only / code lines: ${ratio(sum(prodFiles, 'commentOnly'), sum(prodFiles, 'code'))}; comments containing Chinese: ${ratio(sum(prodFiles, 'cjkComments'), sum(prodFiles, 'comments'))}; exported declarations with JSDoc: ${ratio(sum(prodFiles, 'exportedWithDoc'), sum(prodFiles, 'exported'))}`);
  console.log(`- escape hatches (production): ${JSON.stringify(hatches.prod)}\n`);

  const byDir = new Map();
  for (const f of prodFiles) {
    const parts = f.file.split('/');
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    const d = byDir.get(key) || { files: 0, lines: 0, code: 0, commentOnly: 0 };
    d.files++; d.lines += f.lines; d.code += f.code; d.commentOnly += f.commentOnly;
    byDir.set(key, d);
  }
  console.log('| directory | files | lines | comment ratio |\n| --- | --- | --- | --- |');
  for (const [k, d] of [...byDir].sort((a, b) => b[1].lines - a[1].lines)) {
    console.log(`| ${k} | ${d.files} | ${d.lines} | ${ratio(d.commentOnly, d.code)} |`);
  }
  const table = (title, rows) => {
    console.log(`\n## ${title}\n\n| function | file:line | lines | complexity | depth | params |\n| --- | --- | --- | --- | --- | --- |`);
    for (const f of rows.slice(0, top)) console.log(`| ${f.name} | ${f.file}:${f.line} | ${f.lines} | ${f.complexity} | ${f.depth} | ${f.params} |`);
  };
  table('Longest functions', [...prodFns].sort((a, b) => b.lines - a.lines));
  table('Most complex functions', [...prodFns].sort((a, b) => b.complexity - a.complexity));

  console.log('\n## Highest import fan-in\n\n| module | imported by (production modules under src/) |\n| --- | --- |');
  for (const [k, n] of [...fanIn].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)) {
    console.log(`| ${k} | ${n} |`);
  }
}

if (jsonOutput) {
  const jsonText = JSON.stringify({ generatedAt: new Date().toISOString(), fileStats, fnStats, hatches,
    fanIn: Object.fromEntries(fanIn) }, null, 2);
  process.stdout.write(`${jsonText}\n`);
}
