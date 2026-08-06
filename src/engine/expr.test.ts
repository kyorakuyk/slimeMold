import { describe, it, expect } from 'vitest';
import { evalExpr, ExprError } from './expr';

describe('evalExpr 字面量与基础运算', () => {
  it('空串返回 undefined', () => {
    expect(evalExpr('')).toBeUndefined();
    expect(evalExpr('   ')).toBeUndefined();
  });

  it('数字与字符串字面量', () => {
    expect(evalExpr('42')).toBe(42);
    expect(evalExpr('3.14')).toBe(3.14);
    expect(evalExpr('"hello"')).toBe('hello');
    expect(evalExpr("'world'")).toBe('world');
  });

  it('布尔与 null', () => {
    expect(evalExpr('true')).toBe(true);
    expect(evalExpr('false')).toBe(false);
    expect(evalExpr('null')).toBeNull();
  });

  it('算术运算遵循优先级', () => {
    expect(evalExpr('1 + 2 * 3')).toBe(7);
    expect(evalExpr('(1 + 2) * 3')).toBe(9);
    expect(evalExpr('10 % 3')).toBe(1);
  });

  it('不支持幂运算（** 未实现，抛 ExprError）', () => {
    expect(() => evalExpr('2 ** 3')).toThrow(ExprError);
  });

  it('字符串拼接（任一操作数为字符串）', () => {
    expect(evalExpr('"a" + 1')).toBe('a1');
    expect(evalExpr('1 + "b"')).toBe('1b');
  });

  it('比较与逻辑', () => {
    expect(evalExpr('1 < 2')).toBe(true);
    expect(evalExpr('3 >= 3')).toBe(true);
    expect(evalExpr('1 == 1')).toBe(true);
    expect(evalExpr('1 != 2')).toBe(true);
    expect(evalExpr('true && false')).toBe(false);
    expect(evalExpr('true || false')).toBe(true);
  });
});

describe('evalExpr 变量与成员访问', () => {
  it('简单变量取值', () => {
    expect(evalExpr('x', { x: 10 })).toBe(10);
    expect(evalExpr('missing', {})).toBeUndefined();
  });

  it('点成员访问', () => {
    expect(evalExpr('user.name', { user: { name: 'bob' } })).toBe('bob');
  });

  it('方括号索引（数组/对象）', () => {
    expect(evalExpr('arr[1]', { arr: [10, 20, 30] })).toBe(20);
    expect(evalExpr('obj["k"]', { obj: { k: 'v' } })).toBe('v');
  });

  it('成员访问作用于解析后的值', () => {
    expect(evalExpr('a.b.c', { a: { b: { c: 42 } } })).toBe(42);
  });
});

describe('evalExpr 内置函数', () => {
  it('len', () => {
    expect(evalExpr('len("hello")')).toBe(5);
    expect(evalExpr('len(arr)', { arr: [1, 2, 3] })).toBe(3);
    expect(evalExpr('len(obj)', { obj: { a: 1, b: 2 } })).toBe(2);
  });

  it('大小写与 trim', () => {
    expect(evalExpr('upper("ab")')).toBe('AB');
    expect(evalExpr('lower("AB")')).toBe('ab');
    expect(evalExpr('trim("  x  ")')).toBe('x');
  });

  it('数值函数', () => {
    expect(evalExpr('round(3.6)')).toBe(4);
    expect(evalExpr('abs(-7)')).toBe(7);
    expect(evalExpr('min(3, 1, 2)')).toBe(1);
    expect(evalExpr('max(3, 1, 2)')).toBe(3);
  });

  it('字符串处理', () => {
    expect(evalExpr('split("a,b", ",")')).toEqual(['a', 'b']);
    expect(evalExpr('join(arr, "-")', { arr: ['x', 'y'] })).toBe('x-y');
    expect(evalExpr('replace("a.b", ".", "-")')).toBe('a-b');
    expect(evalExpr('contains("hello", "ell")')).toBe(true);
    expect(evalExpr('slice("hello", 1, 3)')).toBe('el');
    expect(evalExpr('isEmpty("")')).toBe(true);
    expect(evalExpr('isEmpty("x")')).toBe(false);
  });

  it('函数可嵌套', () => {
    expect(evalExpr('upper(trim("  ab  "))')).toBe('AB');
  });
});

describe('evalExpr 三元与错误', () => {
  it('三元表达式', () => {
    expect(evalExpr('1 > 0 ? "yes" : "no"')).toBe('yes');
    expect(evalExpr('1 < 0 ? "yes" : "no"')).toBe('no');
  });

  it('变量名可嵌入三元', () => {
    expect(evalExpr('flag ? a : b', { flag: true, a: 1, b: 2 })).toBe(1);
  });

  it('语法错误抛出 ExprError', () => {
    expect(() => evalExpr('1 +')).toThrow(ExprError);
    expect(() => evalExpr('? 1 : 2')).toThrow(ExprError);
  });

  it('无法识别字符抛出 ExprError', () => {
    expect(() => evalExpr('1 @ 2')).toThrow(ExprError);
  });
});
