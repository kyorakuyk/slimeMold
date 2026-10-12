import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectControlDirectory = resolve(process.cwd(), 'src/projectControl');
const readmePath = resolve(projectControlDirectory, 'README.md');

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('projectControl code map', () => {
  it('lists each non-test worker module exactly once in the subsystem table', () => {
    expect(existsSync(readmePath), 'src/projectControl/README.md must exist').toBe(true);
    const readme = readFileSync(readmePath, 'utf8');
    const sectionStart = readme.indexOf('## 子系统表');
    expect(sectionStart, 'README must contain the 子系统表 section').toBeGreaterThanOrEqual(0);
    const nextSection = readme.indexOf('\n## ', sectionStart + 1);
    const subsystemTable = nextSection < 0 ? readme.slice(sectionStart) : readme.slice(sectionStart, nextSection);
    const workerFiles = readdirSync(projectControlDirectory)
      .filter((name) => /^worker.*\.ts$/.test(name) && !name.endsWith('.test.ts') && !name.includes('testFixtures'))
      .sort();

    expect(workerFiles.length).toBeGreaterThan(0);
    for (const file of workerFiles) {
      const references = subsystemTable.match(new RegExp('`' + escaped(file) + '`', 'g')) ?? [];
      expect(references, `${file} must appear exactly once in the subsystem table`).toHaveLength(1);
    }
  });

  it('references only existing src paths', () => {
    expect(existsSync(readmePath), 'src/projectControl/README.md must exist').toBe(true);
    const readme = readFileSync(readmePath, 'utf8');
    const references = [...readme.matchAll(/`(src\/[^`]+)`/g)].map((match) => match[1]);
    const mentionedPaths = readme.match(/src\//g) ?? [];

    expect(references).toHaveLength(mentionedPaths.length);
    for (const path of references) {
      expect(existsSync(resolve(process.cwd(), path)), `${path} must exist`).toBe(true);
    }
  });
});
