/* Reading just enough of a media source to identify it: the head of the file
 * and, for containers that keep their index at the end (MP4 with a trailing
 * `moov`), the tail. Local files are read with two positioned reads; remote
 * ones with HTTP range requests, so probing a URL costs the same as a local
 * file. Shared by `bevara probe` and `bevara update-page`.
 */
import fs from 'node:fs';
import { CliError } from './ui.js';

export const HEAD_DEFAULT = 256 * 1024;
export const TAIL_DEFAULT = 1024 * 1024;

export const isUrl = (s) => /^https?:\/\//i.test(s);

export async function readLocal(file, headBytes = HEAD_DEFAULT) {
  const st = await fs.promises.stat(file);
  if (st.isDirectory()) throw new CliError(`${file} is a directory`);
  const fd = await fs.promises.open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(headBytes, st.size));
    if (head.length) await fd.read(head, 0, head.length, 0);
    const tailLen = Math.min(TAIL_DEFAULT, Math.max(0, st.size - head.length));
    const tail = Buffer.alloc(tailLen);
    if (tailLen) await fd.read(tail, 0, tailLen, st.size - tailLen);
    return { head, tail, size: st.size, mime: null };
  } finally { await fd.close(); }
}

// A server that ignores Range simply returns the whole body, which still works.
export async function readRemote(url, headBytes = HEAD_DEFAULT) {
  const get = async (range) => {
    let res;
    try { res = await fetch(url, { headers: range ? { range } : {} }); }
    catch (e) { throw new CliError(`cannot fetch ${url}: ${e.cause?.message ?? e.message}`); }
    if (!res.ok && res.status !== 206) throw new CliError(`cannot fetch ${url}: HTTP ${res.status}`);
    return res;
  };
  const res = await get(`bytes=0-${headBytes - 1}`);
  const head = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? null;
  let size = null, tail = Buffer.alloc(0);
  const cr = res.headers.get('content-range');
  if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) size = parseInt(m[1], 10); }
  else if (res.headers.get('content-length')) size = parseInt(res.headers.get('content-length'), 10);
  if (size && size > head.length && res.status === 206) {
    const from = Math.max(head.length, size - TAIL_DEFAULT);
    try { tail = Buffer.from(await (await get(`bytes=${from}-${size - 1}`)).arrayBuffer()); } catch { /* head is enough */ }
  }
  return { head, tail, size, mime };
}

export function readSource(target, headBytes = HEAD_DEFAULT) {
  return isUrl(target) ? readRemote(target, headBytes) : readLocal(target, headBytes);
}
