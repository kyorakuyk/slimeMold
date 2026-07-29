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

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
      toks.push({ type: 'num', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let j = i + 1;
      let str = '';
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\' && j + 1 < n) {
          const nx = src[j + 1];
          str += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx === '\\' ? '\\' : nx;
          j += 2;
        } else {
          str += src[j];
          j++;
        }
      }
      toks.push({ type: 'str', value: str });
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      toks.push({ type: 'ident', value: src.slice(i, j) });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (three === '===' || three === '!==') {
      toks.push({ type: 'op', value: three.slice(0, 2) });
      i += 3;
      continue;
    }
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      toks.push({ type: 'op', value: two });
      i += 2;
      continue;
    }
    if ('+-*/%<>!'.includes(c)) {
      toks.push({ type: 'op', value: c });
      i++;
      continue;
    }
    if (c === '(') {
      toks.push({ type: 'lparen', value: c });
      i++;
      continue;
    }
    if (c === ')') {
      toks.push({ type: 'rparen', value: c });
      i++;
      continue;
    }
    if (c === '[') {
      toks.push({ type: 'lbracket', value: c });
      i++;
      continue;
    }
    if (c === ']') {
      toks.push({ type: 'rbracket', value: c });
      i++;
      continue;
    }
    if (c === ',') {
      toks.push({ type: 'comma', value: c });
      i++;
      continue;
    }
    if (c === '.') {
      toks.push({ type: 'dot', value: c });
      i++;
      continue;
    }
    if (c === '?') {
      toks.push({ type: 'ques', value: c });
      i++;
      continue;
    }
    if (c === ':') {
      toks.push({ type: 'colon', value: c });
      i++;
      continue;
    }
    throw new ExprError(`无法识别的字符: "${c}"`);
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
