/* Service worker for media preserved with `bevara preserve`.
 *
 * It extends the MP4 Service Worker of GPAC (https://github.com/gpac/mp4box-sw):
 * opening an .mp4 whose meta box has the "html" handler serves its primary
 * item - the page - in place of the file, and the requests that page makes
 * are answered from the items of the same file. Two changes:
 *
 *   - an item is named by its path relative to the directory of the .mp4
 *     (the original strips the characters the request URL shares with the
 *     .mp4 URL, which breaks as soon as a name begins like the file's);
 *   - the package a request belongs to is found from the page that issued it
 *     (its client), not only from the Referer, and is parsed again after the
 *     worker restarts.
 *
 * mp4box.js (BSD-3-Clause, GPAC) reads the file: ./mp4box/mp4box.all.mjs.
 */
import { createFile, Log } from './mp4box/mp4box.all.mjs';

Log.setLogLevel(Log.error);

// .mp4 URL -> Promise<{ iso, base } | null>
const packages = new Map();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const withoutHash = (url) => url.split('#')[0];

function load(url) {
  url = withoutHash(url);
  if (!packages.has(url)) {
    packages.set(url, (async () => {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buffer = await res.arrayBuffer();
      buffer.fileStart = 0;
      const iso = createFile();
      iso.appendBuffer(buffer);
      iso.flush();
      if (iso.getMetaHandler() !== 'html' || !iso.getPrimaryItem()) return null;
      return { iso, base: new URL('.', url).href };
    })().catch(() => null));
  }
  return packages.get(url);
}

const isPackageUrl = (url) => /\.mp4$/i.test(new URL(url).pathname);

// A HEAD (the player asks a source's type and size first) gets the headers alone.
function itemResponse(item, method = 'GET') {
  const headers = { 'content-type': item.content_type || 'application/octet-stream', 'content-length': String(item.data.byteLength) };
  return new Response(method === 'HEAD' ? null : item.data, { status: 200, headers });
}

// The .mp4 a request comes from: the page (client) that made it, else its Referer.
async function packageOf(event) {
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  for (const url of [client?.url, event.request.referrer]) {
    if (url && isPackageUrl(url)) {
      const pkg = await load(url);
      if (pkg) return pkg;
    }
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if ((req.method !== 'GET' && req.method !== 'HEAD') || new URL(req.url).origin !== self.location.origin) return;

  // Opening the .mp4 itself: its page, when it carries one.
  if (req.mode === 'navigate' && isPackageUrl(req.url)) {
    event.respondWith((async () => {
      const pkg = await load(req.url);
      return pkg ? itemResponse(pkg.iso.getPrimaryItem()) : fetch(req);
    })());
    return;
  }

  event.respondWith((async () => {
    const pkg = await packageOf(event);
    const url = withoutHash(req.url).split('?')[0];
    if (pkg && url.startsWith(pkg.base)) {
      const id = pkg.iso.hasItem(decodeURIComponent(url.slice(pkg.base.length)));
      if (id !== -1) return itemResponse(pkg.iso.getItem(id), req.method);
    }
    return fetch(req);
  })());
});
