/**
 * 安全表达式求值引擎（无 eval / new Function）。
 * 支持：数字、字符串、布尔、null、变量、.成员访问、[索引]、函数调用、
 * 以及一元/二元/逻辑/比较/三元运算。用于「表达式」节点与变量计算。
 */

export class ExprError extends Error {}

type Value = unknown;

const FUNCS: Record<string, (...args: Value[]) => Value> = {
  len: (v) =>
    Array.isArray(v)
      ? v.length
      : typeof v === 'string'
        ? v.length
        : v && typeof v === 'object'
          ? Object.keys(v).length
          : 0,
  upper: (v) => String(v ?? '').toUpperCase(),
  lower: (v) => String(v ?? '').toLowerCase(),
  trim: (v) => String(v ?? '').trim(),
  round: (v) => Math.round(Number(v)),
  floor: (v) => Math.floor(Number(v)),
  ceil: (v) => Math.ceil(Number(v)),
  abs: (v) => Math.abs(Number(v)),
  min: (...a) => Math.min(...a.map(Number)),
  max: (...a) => Math.max(...a.map(Number)),
  num: (v) => Number(v),
  str: (v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)),
  bool: (v) => Boolean(v),
  slice: (v, start, end) =>
    String(v ?? '').slice(Number(start), end == null ? undefined : Number(end)),
  join: (v, sep) =>
    Array.isArray(v)
      ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(String(sep ?? ''))
      : String(v),
  split: (v, sep) => String(v ?? '').split(String(sep ?? '')),
  replace: (v, a, b) => String(v ?? '').split(String(a)).join(String(b)),
  contains: (v, sub) => String(v ?? '').includes(String(sub ?? '')),
  isEmpty: (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0),
};

type TokType =
  | 'num'
  | 'str'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'dot'
  | 'ques'
  | 'colon'
  | 'eof';

interface Tok {
  type: TokType;
  value: string;
}

const PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '<': 4,
  '>': 4,
  '<=': 4,
  '>=': 4,
  '+': 5,
  '-': 5,
  '*': 6,
  '/': 6,
  '%': 6,
};

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);

interface TokenScan {
  token: Tok;
  nextIndex: number;
}

function scanNumberToken(src: string, start: number): TokenScan {
  let end = start + 1;
  while (end < src.length && (isDigit(src[end]) || src[end] === '.')) end++;
  return { token: { type: 'num', value: src.slice(start, end) }, nextIndex: end };
}

function scanStringToken(src: string, start: number): TokenScan {
  const quote = src[start];
  let end = start + 1;
  let value = '';
  while (end < src.length && src[end] !== quote) {
    if (src[end] === '\\' && end + 1 < src.length) {
      const next = src[end + 1];
      value += next === 'n' ? '\n' : next === 't' ? '\t' : next === '\\' ? '\\' : next;
      end += 2;
    } else {
      value += src[end];
      end++;
    }
  }
  return { token: { type: 'str', value }, nextIndex: end + 1 };
}

function scanIdentifierToken(src: string, start: number): TokenScan {
  let end = start + 1;
  while (end < src.length && isIdentPart(src[end])) end++;
  return { token: { type: 'ident', value: src.slice(start, end) }, nextIndex: end };
}

function scanOperatorToken(src: string, start: number): TokenScan | null {
  const three = src.slice(start, start + 3);
  if (three === '===' || three === '!==') {
    return { token: { type: 'op', value: three.slice(0, 2) }, nextIndex: start + 3 };
  }
  const two = src.slice(start, start + 2);
  if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
    return { token: { type: 'op', value: two }, nextIndex: start + 2 };
  }
  const operator = src[start];
  if ('+-*/%<>!'.includes(operator)) {
    return { token: { type: 'op', value: operator }, nextIndex: start + 1 };
  }
  return null;
}

function scanPunctuationToken(char: string): Tok | null {
  switch (char) {
    case '(': return { type: 'lparen', value: char };
    case ')': return { type: 'rparen', value: char };
    case '[': return { type: 'lbracket', value: char };
    case ']': return { type: 'rbracket', value: char };
    case ',': return { type: 'comma', value: char };
    case '.': return { type: 'dot', value: char };
    case '?': return { type: 'ques', value: char };
    case ':': return { type: 'colon', value: char };
    default: return null;
  }
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const char = src[i];
    if (char === ' ' || char === '\t' || char === '\n' || char.charCodeAt(0) === 13) {
      i++;
      continue;
    }
    if (isDigit(char) || (char === '.' && isDigit(src[i + 1] ?? ''))) {
      const scan = scanNumberToken(src, i);
      toks.push(scan.token);
      i = scan.nextIndex;
      continue;
    }
    if (char === '"' || char === "'") {
      const scan = scanStringToken(src, i);
      toks.push(scan.token);
      i = scan.nextIndex;
      continue;
    }
    if (isIdentStart(char)) {
      const scan = scanIdentifierToken(src, i);
      toks.push(scan.token);
      i = scan.nextIndex;
      continue;
    }
    const operator = scanOperatorToken(src, i);
    if (operator) {
      toks.push(operator.token);
      i = operator.nextIndex;
      continue;
    }
    const punctuation = scanPunctuationToken(char);
    if (punctuation) {
      toks.push(punctuation);
      i++;
      continue;
    }
    throw new ExprError(`无法识别的字符: "${char}"`);
  }
  toks.push({ type: 'eof', value: '' });
  return toks;
}

/** 占位标记：标识一个尚未取值的变量名（需经成员访问/取值解析） */
const VAR = Symbol('var');
type VarMarker = { [VAR]: string };

function isVarMarker(v: Value): v is VarMarker {
  return typeof v === 'object' && v !== null && VAR in (v as object);
}

function resolve(scope: Record<string, unknown>, v: Value): Value {
  if (isVarMarker(v)) return scope[(v as VarMarker)[VAR]];
  return v;
}

export function evalExpr(src: string, scope: Record<string, unknown> = {}): unknown {
  if (!src || !src.trim()) return undefined;
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t: TokType) => {
    if (toks[pos].type !== t) throw new ExprError(`语法错误：期望 ${t}，得到 "${toks[pos].value}"`);
    return toks[pos++];
  };

  const applyBinary = (op: string, l: Value, r: Value): Value => {
    switch (op) {
      case '+':
        return typeof l === 'string' || typeof r === 'string'
          ? String(l) + String(r)
          : Number(l) + Number(r);
      case '-':
        return Number(l) - Number(r);
      case '*':
        return Number(l) * Number(r);
      case '/':
        return Number(l) / Number(r);
      case '%':
        return Number(l) % Number(r);
      case '==':
        return (l as unknown) == (r as unknown);
      case '!=':
        return (l as unknown) != (r as unknown);
      case '<':
        return Number(l) < Number(r);
      case '>':
        return Number(l) > Number(r);
      case '<=':
        return Number(l) <= Number(r);
      case '>=':
        return Number(l) >= Number(r);
      case '&&':
        return l && r;
      case '||':
        return l || r;
    }
    throw new ExprError(`未知运算符: ${op}`);
  };

  const parseArgs = (): Value[] => {
    expect('lparen');
    const args: Value[] = [];
    if (peek().type === 'rparen') {
      next();
      return args;
    }
    while (true) {
      args.push(parseExpr());
      if (peek().type === 'comma') {
        next();
        continue;
      }
      break;
    }
    expect('rparen');
    return args;
  };

  const parsePrimary = (): Value => {
    const t = peek();
    if (t.type === 'num') {
      next();
      return Number(t.value);
    }
    if (t.type === 'str') {
      next();
      return t.value;
    }
    if (t.type === 'ident') {
      const name = t.value;
      next();
      if (name === 'true') return true;
      if (name === 'false') return false;
      if (name === 'null') return null;
      if (FUNCS[name] && peek().type === 'lparen') {
        const args = parseArgs();
        return FUNCS[name](...args);
      }
      return { [VAR]: name } as VarMarker;
    }
    if (t.type === 'lparen') {
      next();
      const v = parseExpr();
      expect('rparen');
      return v;
    }
    throw new ExprError(`意外的标记: "${t.value || t.type}"`);
  };

  const parsePostfix = (): Value => {
    let base = parsePrimary();
    while (true) {
      const t = peek();
      if (t.type === 'dot') {
        next();
        const id = next();
        if (id.type !== 'ident') throw new ExprError('成员访问需为标识符');
        const resolved = resolve(scope, base) as Record<string, unknown> | null;
        base = resolved == null ? undefined : resolved[id.value];
      } else if (t.type === 'lbracket') {
        next();
        const idx = parseExpr();
        expect('rbracket');
        const resolved = resolve(scope, base) as Record<string | number, unknown> | null;
        base = resolved == null ? undefined : resolved[idx as string | number];
      } else {
        break;
      }
    }
    return resolve(scope, base);
  };

  const parseUnary = (): Value => {
    const t = peek();
    if (t.type === 'op' && (t.value === '-' || t.value === '!')) {
      next();
      const v = parseUnary();
      return t.value === '-' ? -Number(v) : !v;
    }
    return parsePostfix();
  };

  const parseBinary = (minPrec: number): Value => {
    let left = parseUnary();
    while (true) {
      const t = peek();
      if (t.type !== 'op' || PREC[t.value] === undefined || PREC[t.value] < minPrec) break;
      const op = t.value;
      next();
      const right = parseBinary(PREC[op] + 1);
      left = applyBinary(op, left, right);
    }
    return left;
  };

  const parseExpr = (): Value => {
    const cond = parseBinary(1);
    if (peek().type === 'ques') {
      next();
      const truthy = parseExpr();
      if (peek().type !== 'colon') throw new ExprError('三元表达式缺少 ":"');
      next();
      const falsy = parseExpr();
      return cond ? truthy : falsy;
    }
    return cond;
  };

  const result = parseExpr();
  if (peek().type !== 'eof') throw new ExprError(`多余的内容: "${peek().value}"`);
  return result;
}
