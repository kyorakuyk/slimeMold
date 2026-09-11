import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const styles = readFileSync(resolve(process.cwd(), 'src/styles/typora.css'), 'utf8');
const appContentRule = styles.match(/\.sm-app-content\s*\{([\s\S]*?)\}/)?.[1] ?? '';

describe('desktop app layout contracts', () => {
  it('stacks the advanced toolbar above the main workspace', () => {
    expect(appContentRule).toMatch(/display:\s*flex/);
    expect(appContentRule).toMatch(/flex-direction:\s*column/);
  });
});
