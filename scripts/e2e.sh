#!/usr/bin/env bash
# End-to-end test: boots a registry on a random port and drives it with the CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
BEVARA="node $ROOT/packages/cli/bin/bevara.js"
FIXTURE="$ROOT/packages/registry/test/fixtures/dummy_1.wasm"
PORT=$(( 20000 + RANDOM % 20000 ))

export BEVARA_CONFIG="$WORK/.bevararc"
export BEVARA_REGISTRY="http://127.0.0.1:$PORT"
export BEVARA_PASSWORD="password123"
export NO_COLOR=1

cleanup() { kill "$REG_PID" 2>/dev/null || true; [ -n "${KEEP_WORK:-}" ] && echo "kept $WORK" || rm -rf "$WORK"; }
trap cleanup EXIT

PORT=$PORT DATA_DIR="$WORK/data" node "$ROOT/packages/registry/src/server.js" >"$WORK/registry.log" 2>&1 &
REG_PID=$!
for i in $(seq 1 50); do curl -fs "$BEVARA_REGISTRY/-/ping" >/dev/null 2>&1 && break; sleep 0.1; done

step() { echo; echo "=== $*"; }
expect_fail() { if "$@"; then echo "expected failure: $*"; exit 1; fi; }
# `a && b` does not stop `set -e` when a fails: use explicit checks.
check() { if ! "$@"; then echo "CHECK FAILED: $*"; exit 1; fi; }

step "ping / adduser / whoami"
$BEVARA ping
$BEVARA adduser -u alice -e alice@example.org
$BEVARA whoami | grep -q alice

step "publish the runtime solver_1 that filters name in \"using\" (required, and checked by the registry)"
mkdir -p "$WORK/solver" && cd "$WORK/solver"
printf '{ "name": "solver", "kind": "runtime", "description": "Test solver", "patents": { "status": "royalty-free" } }\n' > solver.json
printf 'cmake_minimum_required(VERSION 3.7)\nset(VERSION "1")\nadd_executable(solver_${VERSION} gpac.c)\n' > CMakeLists.txt
printf 'Module._fin_register; Module._fout_register;\n' > loader.js
printf 'SPDX-License-Identifier: LGPL-2.1-or-later\n' > LICENCE
mkdir -p .bevara/.build && cp "$FIXTURE" .bevara/.build/solver_1.wasm && printf 'var libgpac=()=>{};\n' > .bevara/.build/solver_1.js
$BEVARA publish -y | grep 'runtime with built-in filters fin, fout' >/dev/null
curl -fs -o /dev/null -w '%{http_code} %{content_type}\n' "$BEVARA_REGISTRY/accessors/solver_1.js" | grep -q '200 text/javascript'

step "publish the tag scripts (kind \"tags\"), then list them with bevara tags"
mkdir -p "$WORK/player/build/dist" && cd "$WORK/player"
printf '{ "name": "universal-tags", "kind": "tags", "description": "Universal elements", "tags": ["universal-img_1.js", "universal-video_1.js"], "main": "build/dist", "patents": { "status": "royalty-free" } }\n' > universal-tags.json
printf 'SPDX-License-Identifier: ISC\n' > LICENCE
printf '/*! notice */ customElements.define("universal-img_1")\n' > build/dist/universal-img_1.js
printf '/*! notice */ customElements.define("universal-video_1")\n' > build/dist/universal-video_1.js
$BEVARA publish -y | grep 'bevara:universal-tags@1.0.0' >/dev/null
$BEVARA tags --remote | grep -q 'universal-img_1, universal-video_1'
curl -fs "$BEVARA_REGISTRY/accessors/universal-img_1.js" | grep -q 'universal-img_1'

step "init a filter (non-interactive) and fake the build with the fixture"
mkdir -p "$WORK/dummy" && cd "$WORK/dummy"
$BEVARA init -y -n dummy --patents royalty-free
check test -f dummy.json
check test ! -f bevara.json
check test -f CMakeLists.txt
check test -f src/dummy.c
check test -f filters.cmake
mkdir -p build && cp "$FIXTURE" build/dummy_1.wasm

step "pack --dry-run, publish (signs with an auto-generated key, appended to the log)"
$BEVARA pack --dry-run
$BEVARA publish -y | grep 'log #3' >/dev/null       # #1 is the runtime, #2 the tag scripts
$BEVARA key ls | grep -q active
$BEVARA key show | grep -q '^sha256:'
$BEVARA log | grep -q 'bevara:dummy@1.0.0'
$BEVARA log --verify | grep -q 'verified 3 entries'
expect_fail $BEVARA publish -y      # same version again -> 409
expect_fail $BEVARA publish -y --no-sign

step "publish a second filter depending on dummy"
mkdir -p "$WORK/second" && cd "$WORK/second"
$BEVARA init -y -n second --patents royalty-free
mkdir -p build && cp "$FIXTURE" build/second_1.wasm
node -e "const f='second.json',m=JSON.parse(require('fs').readFileSync(f));m.dependencies={dummy:'^1.0.0'};require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
$BEVARA publish -y

step "catalog: filters --remote / runtimes --remote / search / info"
$BEVARA filters --remote | grep -q dummy
$BEVARA runtimes --remote | grep -q 'solver_1'
$BEVARA search second | grep -q second
$BEVARA info second | grep -q 'dummy@^1.0.0'
$BEVARA info second | grep -q 'log #'
$BEVARA info dummy --json | node -e "const d=JSON.parse(require('fs').readFileSync(0));if(d.dist.file!=='dummy_1.wasm')process.exit(1)"

step "site project: install resolves transitive deps, writes lock + accessors/"
mkdir -p "$WORK/site" && cd "$WORK/site"
$BEVARA install second
check test -f accessors/second_1.wasm
check test -f accessors/dummy_1.wasm
check test -f bevara-lock.json
check test -f accessors/dummy.json
grep -q '"bevara:second": "\^1.0.0"' bevara.json
$BEVARA filters | grep -q 'with="'
$BEVARA install                     # idempotent
$BEVARA audit
check grep -q '"log"' bevara-lock.json
check grep -q '"registryKeyId"' bevara-lock.json
grep -q '"keyId": "sha256:' bevara-lock.json
$BEVARA log --verify | grep 'from genesis' >/dev/null

step "publish dummy 1.1.0 -> outdated / update"
cd "$WORK/dummy"
node -e "const f='dummy.json',m=JSON.parse(require('fs').readFileSync(f));m.version='1.1.0';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
$BEVARA publish -y
cd "$WORK/site"
$BEVARA outdated | grep -q '1.1.0'
$BEVARA update | grep -q '1.0.0.*→.*1.1.0'
grep -q '"version": "1.1.0"' bevara-lock.json
$BEVARA outdated | grep -q 'up to date'

step "audit: tampering, advisory, deprecation are reported (exit 1), --fix repairs"
printf 'garbage' >> accessors/dummy_1.wasm
expect_fail $BEVARA audit
$BEVARA advisory add dummy '<1.2.0' 'Test advisory' --severity high
$BEVARA advisory ls | grep -q 'Test advisory'
$BEVARA deprecate second 'use third instead'
set +e; $BEVARA audit > "$WORK/audit.txt"; RC=$?; set -e
check test $RC -eq 1
check grep -q integrity "$WORK/audit.txt"
check grep -q advisory "$WORK/audit.txt"
check grep -q deprecated "$WORK/audit.txt"
check grep -q signature "$WORK/audit.txt"
$BEVARA audit --fix --audit-level critical || true
($BEVARA audit --json || true) | node -e "const d=JSON.parse(require('fs').readFileSync(0));if(d.findings.some(f=>f.kind==='integrity'||f.kind==='module'))process.exit(1)"
$BEVARA deprecate second ''
$BEVARA advisory rm 1

step "uninstall removes files; install -E pins"
$BEVARA uninstall second
check test ! -f accessors/second_1.wasm
check test ! -f accessors/dummy_1.wasm
$BEVARA install dummy@1.0.0 -E
check grep -q '"bevara:dummy": "1.0.0"' bevara.json
check test -f accessors/dummy_1.wasm

step "a filter repository publishes from its own <name>.json (no bevara.json)"
mkdir -p "$WORK/legacy" && cd "$WORK/legacy"
# The shape of the 14 existing filter manifests: four-space indent, "Format", no version.
cat > legacy.json <<'JSON'
{
    "name": "legacy",
    "description": "Legacy-format decoder",
    "filters":["legacydec"],
    "help": "Decodes the legacy format.",
    "support": [
        "image"
    ],
    "sources":"https://github.com/Bevara/legacy",
    "Format": ["Legacy"],
    "patents": { "status": "royalty-free" },
    "using": ["solver_1"]
}
JSON
mkdir -p build && cp "$FIXTURE" build/legacy_1.wasm
# The licence lives in LICENCE only; the CLI reads it, the manifest never mentions it.
printf 'SPDX-License-Identifier: BSD-3-Clause\n\nRedistribution and use in source and binary forms...\nNeither the name of...\n' > LICENCE
cp legacy.json legacy.json.orig
# No "version": generation 1 (here from the built legacy_1.wasm, as there is no
# CMakeLists.txt) is published as 1.0.0.
$BEVARA publish -y > "$WORK/legacy-publish.txt"
check grep -q 'legacy@1.0.0' "$WORK/legacy-publish.txt"
check grep -q 'version 1.0.0 = generation 1' "$WORK/legacy-publish.txt"
check grep -q '(legacy.json)' "$WORK/legacy-publish.txt"
check grep -q 'licence BSD-3-Clause, from LICENCE' "$WORK/legacy-publish.txt"
$BEVARA info legacy@1.0.0 | grep -q 'BSD-3-Clause'
tar -tzf "$(ls -t $WORK/data/store/bevara:legacy/1.0.0/*.tgz | head -1)" | grep -q 'package/LICENCE'
check cmp -s legacy.json legacy.json.orig                 # publishing wrote nothing into it
# Same generation again: refused, and the hint says how to move on.
set +e; $BEVARA publish -y > "$WORK/legacy-again.txt" 2>&1; RC=$?; set -e
check test $RC -ne 0
check grep -q 'increment the generation' "$WORK/legacy-again.txt"
# With a CMakeLists.txt, its add_filter() generation is authoritative.
printf 'add_filter(legacy\n  "${SRC}" "${LIB}" [] "" "${INC}" ""\n  "2")  # generation\n' > CMakeLists.txt
cp build/legacy_1.wasm build/legacy_2.wasm
$BEVARA publish -y | grep -q 'legacy@2.0.0'
rm CMakeLists.txt build/legacy_2.wasm
$BEVARA info legacy@1.0.0 | grep -q 'Legacy'              # "Format" became formats
# A dependency recorded by the CLI touches nothing else in the file.
$BEVARA install dummy >/dev/null
node -e "
const fs=require('fs');
const a=fs.readFileSync('legacy.json.orig','utf8').split('\\n'), b=fs.readFileSync('legacy.json','utf8').split('\\n');
for (const l of a) if (!b.includes(l) && !/\\}\\s*$/.test(l) && !/"patents"|"using"/.test(l)) { console.error('line changed or lost: '+l); process.exit(1); }
if (!b.some(l=>l.includes('\"filters\":[\"legacydec\"]'))) { console.error('compact array was reformatted'); process.exit(1); }
console.log('  legacy.json kept its layout; added:', b.filter(l=>!a.includes(l)).map(s=>s.trim()).join(' '));"
check test ! -f bevara.json

# Published from elsewhere, with the module in another build directory.
cd "$WORK"
mkdir -p legacy/out && mv legacy/build/legacy_1.wasm legacy/out/
# A release within generation 1: the optional "version" overrides the derived one.
node -e "const fs=require('fs');fs.writeFileSync('legacy/legacy.json',fs.readFileSync('legacy/legacy.json','utf8').replace('\"name\": \"legacy\",','\"name\": \"legacy\",\\n    \"version\": \"1.0.1\",'))"
expect_fail $BEVARA publish legacy -y                 # not in build/ any more
$BEVARA publish legacy -B out -y | grep '(legacy/legacy.json)' >/dev/null
$BEVARA info legacy@1.0.1 | grep -q '1.0.1'
expect_fail $BEVARA publish legacy/out -y             # a named directory is not searched upwards
cd "$WORK/site"

step "probe identifies a file and the accessors it needs"
# A tiny Ogg/Theora-shaped header is enough: probe reads structure, not samples.
node -e "
const fs=require('fs');
const page=(payload,serial)=>{const d=Buffer.from(payload,'latin1');const segs=[];let l=d.length;while(l>=255){segs.push(255);l-=255}segs.push(l);
const h=Buffer.alloc(27);h.write('OggS',0,'latin1');h[5]=2;h.writeUInt32BE(serial,14);h[26]=segs.length;return Buffer.concat([h,Buffer.from(segs),d])};
fs.writeFileSync('$WORK/clip.ogv',Buffer.concat([page('\\x80theora........',1),page('\\x01vorbis........',2)]))"
$BEVARA probe "$WORK/clip.ogv" --offline | grep 'theora_1;vorbis_1' >/dev/null
$BEVARA probe "$WORK/clip.ogv" --json > "$WORK/probe.json"
node -e "
const d=JSON.parse(require('fs').readFileSync('$WORK/probe.json'))[0];
if(d.format!=='theora')throw new Error('format '+d.format);
if(d.container!=='ogg')throw new Error('container '+d.container);
if(d.streams.length!==2)throw new Error('streams '+JSON.stringify(d.streams));
if(!d.required.decode.includes('theora'))throw new Error('required '+JSON.stringify(d.required));
if(d.accessors.some(a=>a.published))throw new Error('nothing is published under these names in this test registry');
console.log('  probe json ok:',d.format,d.streams.map(s=>s.type+'/'+s.codec).join('+'));"
expect_fail $BEVARA probe "$WORK/does-not-exist.ogv"

step "update-page rewrites a page to use the universal tags"
mkdir -p "$WORK/page"
node -e "
const fs=require('fs');
const page=(payload,serial)=>{const d=Buffer.from(payload,'latin1');const segs=[];let l=d.length;while(l>=255){segs.push(255);l-=255}segs.push(l);
const h=Buffer.alloc(27);h.write('OggS',0,'latin1');h[5]=2;h.writeUInt32BE(serial,14);h[26]=segs.length;return Buffer.concat([h,Buffer.from(segs),d])};
fs.writeFileSync('$WORK/page/clip.ogv',Buffer.concat([page('\\x80theora........',1),page('\\x01vorbis........',2)]));
fs.writeFileSync('$WORK/page/shot.png',Buffer.from('89504E470D0A1A0A0000000D49484452','hex'));
fs.writeFileSync('$WORK/page/index.html','<!doctype html>\\n<body>\\n<!-- <img src=\"shot.png\"> -->\\n<img src=\"shot.png\" alt=\"x\">\\n<video src=\"clip.ogv\" controls></video>\\n<script>var a=\"<img src=shot.png>\";</script>\\n</body>')"
cd "$WORK/page"
# Without --write nothing changes on disk.
$BEVARA update-page index.html --offline > "$WORK/page.out"
check grep -q 'universal-video_1' "$WORK/page.out"
check grep -q 'run again with' "$WORK/page.out"
check grep -vq 'universal' index.html
$BEVARA update-page index.html --offline --write >/dev/null
check grep -q 'is="universal-img_1" using="solver_minimal_1" with="libpng_1"' index.html
check grep -q 'with="ogg_1;theora_1;vorbis_1;isobmff_1;libx264_1;libopusenc_1"' index.html
check grep -q '<script src="scripts/universal-video_1.js">' index.html
# The comment and the inline script must be untouched, and a second run is a no-op.
check grep -q '<!-- <img src="shot.png"> -->' index.html
check grep -q 'var a="<img src=shot.png>"' index.html
cp index.html index.html.1
$BEVARA update-page index.html --offline --write >/dev/null
check cmp -s index.html index.html.1
$BEVARA update-page index.html --offline --json | node -e "
const d=JSON.parse(require('fs').readFileSync(0))[0];
if(d.changed)throw new Error('expected no further change');
if(!d.elements.every(e=>/already/.test(e.skipped||'')))throw new Error(JSON.stringify(d.elements));
console.log('  update-page is idempotent')"
cd "$WORK/site"

step "accessor endpoints as a player would use them"
curl -fs -o /dev/null -w '%{http_code} %{content_type}\n' "$BEVARA_REGISTRY/accessors/dummy_1.wasm" | grep -q '200 application/wasm'
curl -fs "$BEVARA_REGISTRY/accessors/filter_list.json" | grep -q '"with"'
curl -fs -H 'Accept-Encoding: br' -o /dev/null -w '%{http_code}\n' "$BEVARA_REGISTRY/accessors/dummy/1.1.0/dummy_1.wasm" | grep -q 200

step "ownership: second user cannot publish over dummy"
$BEVARA logout
$BEVARA adduser -u bob
cd "$WORK/dummy"
node -e "const f='dummy.json',m=JSON.parse(require('fs').readFileSync(f));m.version='1.2.0';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
expect_fail $BEVARA publish -y
$BEVARA login --password -u alice
$BEVARA owner add bob dummy
$BEVARA owner ls dummy | grep -q bob
$BEVARA login --password -u bob
$BEVARA publish -y
$BEVARA unpublish dummy@1.2.0 -y
$BEVARA log | grep -q yanked

step "namespaces: any account publishes in bevara:, its own namespace stays its own, chain still verifies"
# bob is not an administrator: a bare name still publishes, in the default namespace.
mkdir -p "$WORK/bobopen" && cd "$WORK/bobopen"
$BEVARA init -y -n bobopen --patents royalty-free
mkdir -p build && cp "$FIXTURE" build/bobopen_1.wasm
$BEVARA publish -y | grep 'bevara:bobopen@1.0.0' >/dev/null
mkdir -p "$WORK/bobfilter" && cd "$WORK/bobfilter"
$BEVARA init -y -n mine --patents royalty-free
mkdir -p build && cp "$FIXTURE" build/mine_1.wasm
node -e "const f='mine.json',m=JSON.parse(require('fs').readFileSync(f));m.name='bob:mine';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
$BEVARA publish -y | grep 'bob:mine@1.0.0' >/dev/null
$BEVARA namespace ls | grep -q bob
$BEVARA filters --remote | grep -q 'bob:mine'
cd "$WORK/site"
$BEVARA install bob:mine
check test -f accessors/mine_1.wasm
$BEVARA log --verify
$BEVARA audit --audit-level high

step "a rewritten log is detected by the pinned checkpoint"
# Entry #3 is bevara:dummy@1.0.0, which this site installed (#1 the runtime, #2 the tags).
kill "$REG_PID"; sleep 0.3
node -e "
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('$WORK/data/registry.sqlite');
db.prepare(\"UPDATE log SET record = replace(record,'1.0.0','1.0.0-forged') WHERE seq = 3\").run();db.close();"
PORT=$PORT DATA_DIR="$WORK/data" node "$ROOT/packages/registry/src/server.js" >>"$WORK/registry.log" 2>&1 &
REG_PID=$!
for i in $(seq 1 50); do curl -fs "$BEVARA_REGISTRY/-/ping" >/dev/null 2>&1 && break; sleep 0.1; done
set +e; $BEVARA audit > "$WORK/audit2.txt"; RC=$?; set -e
check test $RC -eq 1
check grep -q 'log' "$WORK/audit2.txt"
expect_fail $BEVARA log --verify

$BEVARA logout
expect_fail $BEVARA whoami

echo
echo "E2E OK"
