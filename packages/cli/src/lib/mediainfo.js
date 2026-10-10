/* The tracks of a media file, as MediaInfo names them.
 *
 * The filter manifests describe what they read in MediaInfo's vocabulary
 * ("Format": ["JPEG 2000"], ["AVC"], ["MPEG Audio"]), because that is what the
 * editor matches them against (Editor/Interface, mediainfo.service.ts). Probing
 * with the same library makes the CLI match exactly as the editor does, with no
 * table of names to keep in sync.
 *
 * MediaInfo asks for the chunks it needs; they are served from the head and
 * tail already read when they fall inside, otherwise read from the file (or
 * fetched with a range request), so a large file is not read whole.
 */
import fs from 'node:fs';
import mediaInfoFactory from 'mediainfo.js';
import { isUrl } from './source.js';

let instance = null;
const mediainfo = () => (instance ??= mediaInfoFactory({ format: 'object' }));

function chunkReader(target, { head, tail, size }) {
  const tailStart = size != null && tail?.length ? size - tail.length : Infinity;
  let fd = null;
  const fromFile = async (len, off) => {
    if (isUrl(target)) {
      const res = await fetch(target, { headers: { range: `bytes=${off}-${off + len - 1}` } });
      if (res.status !== 206) return new Uint8Array(0);    // no ranges: what we hold is all MediaInfo gets
      return new Uint8Array(await res.arrayBuffer());
    }
    fd ??= await fs.promises.open(target, 'r');
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, off);
    return buf.subarray(0, bytesRead);
  };
  const read = (len, off) => {
    len = Math.min(len, size - off);
    if (len <= 0) return new Uint8Array(0);
    if (off + len <= head.length) return head.subarray(off, off + len);
    if (off >= tailStart) return tail.subarray(off - tailStart, off - tailStart + len);
    return fromFile(len, off);
  };
  return { read, close: () => fd?.close() };
}

/* MediaInfo's tracks ([{ '@type': 'General', Format: 'Ogg' }, { '@type':
 * 'Video', Format: 'Theora' }, …]), or null when the size is unknown or
 * MediaInfo fails. */
export async function mediaTracks(target, { head, tail, size }) {
  if (size == null) return null;
  const reader = chunkReader(target, { head, tail, size });
  try {
    const result = await (await mediainfo()).analyzeData(size, reader.read);
    return result?.media?.track ?? null;
  } catch {
    return null;
  } finally {
    await reader.close();
  }
}

/* Lets the process exit: the module keeps the Wasm instance alive otherwise. */
export async function closeMediaInfo() {
  if (!instance) return;
  const mi = await instance;
  instance = null;
  mi.close();
}
