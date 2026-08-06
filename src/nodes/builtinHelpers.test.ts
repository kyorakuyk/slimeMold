import { describe, it, expect } from 'vitest';
import {
  inferAssetKind,
  inferFilename,
  langToExt,
  renderTemplate,
  isTruthy,
  normalizeCategory,
  extractModulesFromDesign,
  extractTasksFromPlan,
  checkJsonSchema,
} from './builtinHelpers';

describe('builtinHelpers 纯函数（从 builtin.ts 抽离，行为等价）', () => {
  describe('inferAssetKind', () => {
    it('代码扩展名归为 code', () => {
      expect(inferAssetKind('a.py')).toBe('code');
      expect(inferAssetKind('a.tsx')).toBe('code');
    });
    it('json 归为 json', () => {
      expect(inferAssetKind('x.json')).toBe('json');
    });
    it('图片扩展名归为 image', () => {
      expect(inferAssetKind('p.PNG')).toBe('image');
    });
    it('文本扩展名与未知扩展名归为 text', () => {
      expect(inferAssetKind('r.md')).toBe('text');
      expect(inferAssetKind('noext')).toBe('text');
    });
  });

  describe('langToExt', () => {
    it('常见语言映射', () => {
      expect(langToExt('python')).toBe('py');
      expect(langToExt('typescript')).toBe('ts');
      expect(langToExt('js')).toBe('js');
    });
    it('大小写不敏感、未知返回空串', () => {
      expect(langToExt('PYTHON')).toBe('py');
      expect(langToExt('cobol')).toBe('');
    });
  });

  describe('inferFilename', () => {
    it('优先从 hint 提取显式文件名', () => {
      expect(inferFilename({ hint: '帮我生成 helloworld.py 文件', content: 'print(1)' })).toBe('helloworld.py');
    });
    it('无 hint 时从内容首行围栏推断扩展名', () => {
      const name = inferFilename({ hint: '', content: '```js\nconst a=1\n' });
      expect(name.endsWith('.js')).toBe(true);
    });
    it('无 hint 无内容时兜底 output.txt', () => {
      expect(inferFilename({ hint: '', content: '' })).toBe('output.txt');
    });
  });

  describe('renderTemplate', () => {
    it('替换标量', () => {
      expect(renderTemplate('hi {{name}}', { name: 'kyo' })).toBe('hi kyo');
    });
    it('对象被 JSON 序列化', () => {
      expect(renderTemplate('{{cfg}}', { cfg: { a: 1 } })).toBe('{"a":1}');
    });
    it('缺失值为空串', () => {
      expect(renderTemplate('x={{missing}}y', {})).toBe('x=y');
    });
  });

  describe('isTruthy', () => {
    it('假值集合', () => {
      expect(isTruthy(null)).toBe(false);
      expect(isTruthy(undefined)).toBe(false);
      expect(isTruthy(0)).toBe(false);
      expect(isTruthy('')).toBe(false);
      expect(isTruthy('false')).toBe(false);
      expect(isTruthy('0')).toBe(false);
      expect(isTruthy([])).toBe(false);
      expect(isTruthy({})).toBe(false);
    });
    it('真值集合', () => {
      expect(isTruthy(true)).toBe(true);
      expect(isTruthy(1)).toBe(true);
      expect(isTruthy('hi')).toBe(true);
      expect(isTruthy([1])).toBe(true);
      expect(isTruthy({ a: 1 })).toBe(true);
    });
  });

  describe('normalizeCategory', () => {
    it('空值降级为 data，字符串小写规整', () => {
      expect(normalizeCategory('')).toBe('data');
      expect(normalizeCategory('DATA')).toBe('data');
      expect(normalizeCategory('UI')).toBe('ui');
    });
  });

  describe('extractModulesFromDesign', () => {
    it('解析 ```json 数组', () => {
      const text = '设计如下：\n```json\n[{"name":"登录","category":"ui","scope":["a"]}]\n```';
      const mods = extractModulesFromDesign(text, '目标');
      expect(mods).toHaveLength(1);
      expect(mods[0].name).toBe('登录');
      expect(mods[0].category).toBe('ui');
      expect(mods[0].scope).toEqual(['a']);
    });
    it('解析失败降级为单个模块', () => {
      const mods = extractModulesFromDesign('不是 json', '我的目标');
      expect(mods).toHaveLength(1);
      expect(mods[0].name).toBe('我的目标');
      expect(mods[0].category).toBe('data');
    });
  });

  describe('extractTasksFromPlan', () => {
    it('解析任务数组', () => {
      const text = '计划：\n```json\n[{"label":"写代码"}]\n```';
      const tasks = extractTasksFromPlan(text, '默认');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].label).toBe('写代码');
    });
    it('解析失败降级为单个任务', () => {
      const tasks = extractTasksFromPlan('xxx', '默认任务');
      expect(tasks[0].label).toBe('默认任务');
    });
  });

  describe('checkJsonSchema', () => {
    it('type 不匹配报错', () => {
      expect(checkJsonSchema(1, { type: 'object' })).toEqual(['期望 object，实际 number']);
      expect(checkJsonSchema('x', { type: 'number' })).toEqual(['期望 number，实际 string']);
    });
    it('required 缺失报错', () => {
      expect(checkJsonSchema({ a: 1 }, { required: ['b'] })).toEqual(['缺少必填字段 "b"']);
      expect(checkJsonSchema({ a: 1, b: 2 }, { required: ['b'] })).toEqual([]);
    });
    it('合法值返回空', () => {
      expect(checkJsonSchema({ a: 1 }, { type: 'object' })).toEqual([]);
    });
  });
});
