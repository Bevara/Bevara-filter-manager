import { Parser } from 'tar';
import { HttpError } from './http.js';

// Unpacks a gzipped tarball held in memory into a Map(path -> Buffer).
// Publishing tarballs are small (a manifest, a .wasm, docs) so buffering is fine.
export function extractTarball(buf, { maxEntries = 500, maxTotal = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const files = new Map();
    let total = 0, count = 0;
    const parser = new Parser({
      onReadEntry(entry) {
        count++;
        if (count > maxEntries) return reject(new HttpError(400, 'tarball has too many entries'));
        if (entry.type !== 'File') { entry.resume(); return; }
        if (entry.path.includes('..')) return reject(new HttpError(400, `unsafe path in tarball: ${entry.path}`));
        const chunks = [];
        entry.on('data', (c) => { total += c.length; if (total > maxTotal) reject(new HttpError(413, 'tarball too large')); chunks.push(c); });
        entry.on('end', () => files.set(entry.path.replace(/^\.\//, ''), Buffer.concat(chunks)));
      },
    });
    parser.on('error', (e) => reject(new HttpError(400, `invalid tarball: ${e.message}`)));
    parser.on('end', () => resolve(files));
    parser.end(buf);
  });
}
