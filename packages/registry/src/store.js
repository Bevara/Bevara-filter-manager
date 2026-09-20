// Filesystem layout under DATA_DIR/store:
//   <name>/<version>/<name>-<version>.tgz   the published tarball
//   <name>/<version>/<name>_<abi>.wasm      the accessor, served to players
//   <name>/<version>/<name>_<abi>.wasm.br   brotli-compressed copy
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants as zc } from 'node:zlib';

export class Store {
  constructor(root) { this.root = root; }

  dir(name, version) { return path.join(this.root, name, version); }

  async save(name, version, { tarball, tarballName, wasm, wasmName }) {
    const d = this.dir(name, version);
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, tarballName), tarball);
    await fs.writeFile(path.join(d, wasmName), wasm);
    const br = brotliCompressSync(wasm, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: wasm.length } });
    await fs.writeFile(path.join(d, wasmName + '.br'), br);
    return { brSize: br.length };
  }

  path(name, version, file) {
    // Guard against path traversal: file names are validated upstream but be safe.
    const p = path.join(this.dir(name, version), path.basename(file));
    return p;
  }

  async remove(name, version) {
    await fs.rm(this.dir(name, version), { recursive: true, force: true });
    const parent = path.join(this.root, name);
    const left = await fs.readdir(parent).catch(() => []);
    if (left.length === 0) await fs.rm(parent, { recursive: true, force: true });
  }
}
