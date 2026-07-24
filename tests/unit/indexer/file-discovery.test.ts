import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileDiscovery } from '../../../src/modules/indexer/file-discovery';
import { SecurityFilter } from '../../../src/services/security-filter';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pluvianidae-file-discovery-'));
}

async function writeFile(root: string, relativePath: string, content = ''): Promise<void> {
  const fullPath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

describe('FileDiscovery', () => {
  let root: string;

  beforeEach(async () => {
    root = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('includes only .js/.jsx/.ts/.tsx files and excludes other extensions', async () => {
    await writeFile(root, 'src/index.ts');
    await writeFile(root, 'src/component.jsx');
    await writeFile(root, 'src/component.tsx');
    await writeFile(root, 'src/legacy.js');
    await writeFile(root, 'README.md');
    await writeFile(root, 'src/styles.css');

    const discovery = new FileDiscovery();
    const files = await discovery.discoverFiles(root);
    const relative = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

    expect(relative).toEqual(['src/component.jsx', 'src/component.tsx', 'src/index.ts', 'src/legacy.js']);
  });

  it('excludes node_modules, bower_components, and .pnp directories entirely', async () => {
    await writeFile(root, 'src/index.ts');
    await writeFile(root, 'node_modules/some-lib/index.js');
    await writeFile(root, 'bower_components/some-lib/index.js');
    await writeFile(root, '.pnp/cache/index.js');

    const discovery = new FileDiscovery();
    const files = await discovery.discoverFiles(root);
    const relative = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

    expect(relative).toEqual(['src/index.ts']);
  });

  it('excludes files and folders listed in .gitignore', async () => {
    await writeFile(root, '.gitignore', 'dist/\n*.generated.ts\nsecrets.ts\n');
    await writeFile(root, 'src/index.ts');
    await writeFile(root, 'dist/bundle.js');
    await writeFile(root, 'src/types.generated.ts');
    await writeFile(root, 'secrets.ts');

    const discovery = new FileDiscovery();
    const files = await discovery.discoverFiles(root);
    const relative = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

    expect(relative).toEqual(['src/index.ts']);
  });

  it('does not apply gitignore filtering when no .gitignore file exists', async () => {
    await writeFile(root, 'src/index.ts');
    await writeFile(root, 'dist/bundle.ts');

    const discovery = new FileDiscovery();
    const files = await discovery.discoverFiles(root);
    const relative = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

    expect(relative).toEqual(['dist/bundle.ts', 'src/index.ts']);
  });

  it('excludes sensitive files via the Security Filter integration', async () => {
    await writeFile(root, 'src/index.ts');
    // ".env.ts" is not a realistic sensitive TS file, use a name matching the
    // "*secret*" default pattern which is extension-agnostic for .ts too.
    await writeFile(root, 'src/secret-config.ts');

    const discovery = new FileDiscovery(new SecurityFilter());
    const files = await discovery.discoverFiles(root);
    const relative = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort();

    expect(relative).toEqual(['src/index.ts']);
  });

  it('returns absolute paths', async () => {
    await writeFile(root, 'src/index.ts');

    const discovery = new FileDiscovery();
    const files = await discovery.discoverFiles(root);

    expect(files).toHaveLength(1);
    expect(path.isAbsolute(files[0])).toBe(true);
  });
});
