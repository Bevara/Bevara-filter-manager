// Minimal WebAssembly binary inspector. Enough to check that a file is a
// valid Wasm module, that it was linked as an Emscripten side module (it
// carries a `dylink`/`dylink.0` custom section, which is what the solver's
// dlopen() needs) and to list its imports/exports for `bevara info`.

const KIND = ['func', 'table', 'memory', 'global', 'tag'];

class Reader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  get eof() { return this.pos >= this.buf.length; }
  u8() { return this.buf[this.pos++]; }
  leb() {
    let result = 0, shift = 0, byte;
    do {
      byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }
  str() {
    const len = this.leb();
    const s = this.buf.subarray(this.pos, this.pos + len).toString('utf8');
    this.pos += len;
    return s;
  }
  limits() {
    const flags = this.u8();
    this.leb();
    if (flags & 1) this.leb();
  }
}

export function inspectWasm(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const info = { valid: false, version: null, sideModule: false, dylink: null, customSections: [], imports: [], exports: [], size: buf.length, error: null };
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) {
    info.error = 'not a WebAssembly binary (bad magic)';
    return info;
  }
  info.version = buf.readUInt32LE(4);
  const r = new Reader(buf);
  r.pos = 8;
  try {
    while (!r.eof) {
      const id = r.u8();
      const size = r.leb();
      const end = r.pos + size;
      if (end > buf.length) throw new Error('truncated section');
      if (id === 0) {
        const name = r.str();
        info.customSections.push(name);
        if (name === 'dylink.0' || name === 'dylink') {
          info.sideModule = true;
          info.dylink = readDylink(r, end, name);
        }
      } else if (id === 2) {
        const n = r.leb();
        for (let i = 0; i < n; i++) {
          const module = r.str();
          const field = r.str();
          const kind = r.u8();
          if (kind === 0) r.leb();
          else if (kind === 1) { r.u8(); r.limits(); }
          else if (kind === 2) r.limits();
          else if (kind === 3) { r.u8(); r.u8(); }
          else if (kind === 4) { r.u8(); r.leb(); }
          info.imports.push({ module, name: field, kind: KIND[kind] ?? kind });
        }
      } else if (id === 7) {
        const n = r.leb();
        for (let i = 0; i < n; i++) {
          const name = r.str();
          const kind = r.u8();
          r.leb();
          info.exports.push({ name, kind: KIND[kind] ?? kind });
        }
      }
      r.pos = end;
    }
    info.valid = true;
  } catch (e) {
    info.error = `malformed module: ${e.message}`;
  }
  return info;
}

// dylink.0 = sequence of subsections; subsection 1 (WASM_DYLINK_MEM_INFO)
// holds memory/table sizes; subsection 2 lists needed shared libraries.
function readDylink(r, end, name) {
  const d = { memorySize: null, memoryAlign: null, tableSize: null, tableAlign: null, needed: [] };
  if (name === 'dylink') {
    d.memorySize = r.leb(); d.memoryAlign = r.leb(); d.tableSize = r.leb(); d.tableAlign = r.leb();
    const n = r.leb();
    for (let i = 0; i < n; i++) d.needed.push(r.str());
    return d;
  }
  while (r.pos < end) {
    const type = r.u8();
    const size = r.leb();
    const subEnd = r.pos + size;
    if (type === 1) {
      d.memorySize = r.leb(); d.memoryAlign = r.leb(); d.tableSize = r.leb(); d.tableAlign = r.leb();
    } else if (type === 2) {
      const n = r.leb();
      for (let i = 0; i < n; i++) d.needed.push(r.str());
    }
    r.pos = subEnd;
  }
  return d;
}

// File name of a compiled accessor: `<module>_<abi>.wasm`, matching what the
// universal tags expect in their `with` attribute. `module` defaults to the
// package name without its namespace, and exists so that an accessor whose
// file name is not all-lowercase (libOpenVVC_1.wasm) keeps a lowercase
// package name (bevara:libopenvvc). A runtime passes its version, which its
// file name carries in place of the ABI (mm_solver_1.0.1.wasm).
export function accessorFileName(name, abi, module, version) {
  const short = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
  return `${module || short}_${version ?? abi}.wasm`;
}
