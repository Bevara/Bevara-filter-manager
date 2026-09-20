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

cleanup() { kill "$REG_PID" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

PORT=$PORT DATA_DIR="$WORK/data" node "$ROOT/packages/registry/src/server.js" >"$WORK/registry.log" 2>&1 &
REG_PID=$!
for i in $(seq 1 50); do curl -fs "$BEVARA_REGISTRY/-/ping" >/dev/null 2>&1 && break; sleep 0.1; done

step() { echo; echo "=== $*"; }
expect_fail() { if "$@"; then echo "expected failure: $*"; exit 1; fi; }

step "ping / adduser / whoami"
$BEVARA ping
$BEVARA adduser -u alice -e alice@example.org
$BEVARA whoami | grep -q alice

step "init a filter (non-interactive) and fake the build with the fixture"
mkdir -p "$WORK/dummy" && cd "$WORK/dummy"
$BEVARA init -y -n dummy
test -f bevara.json && test -f CMakeLists.txt && test -f src/dummy.c && test -f filters.cmake
mkdir -p build && cp "$FIXTURE" build/dummy_1.wasm

step "pack --dry-run, publish"
$BEVARA pack --dry-run
$BEVARA publish -y
expect_fail $BEVARA publish -y      # same version again -> 409

step "publish a second filter depending on dummy"
mkdir -p "$WORK/second" && cd "$WORK/second"
$BEVARA init -y -n second
mkdir -p build && cp "$FIXTURE" build/second_1.wasm
node -e "const f='bevara.json',m=JSON.parse(require('fs').readFileSync(f));m.dependencies={dummy:'^1.0.0'};require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
$BEVARA publish -y

step "catalog: list --remote / search / info"
$BEVARA list --remote | grep -q dummy
$BEVARA search second | grep -q second
$BEVARA info second | grep -q 'dummy@^1.0.0'
$BEVARA info dummy --json | node -e "const d=JSON.parse(require('fs').readFileSync(0));if(d.dist.file!=='dummy_1.wasm')process.exit(1)"

step "site project: install resolves transitive deps, writes lock + accessors/"
mkdir -p "$WORK/site" && cd "$WORK/site"
$BEVARA install second
test -f accessors/second_1.wasm && test -f accessors/dummy_1.wasm && test -f bevara-lock.json && test -f accessors/dummy.json
grep -q '"second": "\^1.0.0"' bevara.json
$BEVARA list | grep -q 'with="'
$BEVARA install                     # idempotent
$BEVARA audit

step "publish dummy 1.1.0 -> outdated / update"
cd "$WORK/dummy"
node -e "const f='bevara.json',m=JSON.parse(require('fs').readFileSync(f));m.version='1.1.0';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
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
test $RC -eq 1
grep -q integrity "$WORK/audit.txt" && grep -q advisory "$WORK/audit.txt" && grep -q deprecated "$WORK/audit.txt"
$BEVARA audit --fix --audit-level critical || true
($BEVARA audit --json || true) | node -e "const d=JSON.parse(require('fs').readFileSync(0));if(d.findings.some(f=>f.kind==='integrity'||f.kind==='module'))process.exit(1)"
$BEVARA deprecate second ''
$BEVARA advisory rm 1

step "uninstall removes files; install -E pins"
$BEVARA uninstall second
test ! -f accessors/second_1.wasm && test ! -f accessors/dummy_1.wasm
$BEVARA install dummy@1.0.0 -E
grep -q '"dummy": "1.0.0"' bevara.json && test -f accessors/dummy_1.wasm

step "accessor endpoints as a player would use them"
curl -fs -o /dev/null -w '%{http_code} %{content_type}\n' "$BEVARA_REGISTRY/accessors/dummy_1.wasm" | grep -q '200 application/wasm'
curl -fs "$BEVARA_REGISTRY/accessors/filter_list.json" | grep -q '"with"'
curl -fs -H 'Accept-Encoding: br' -o /dev/null -w '%{http_code}\n' "$BEVARA_REGISTRY/accessors/dummy/1.1.0/dummy_1.wasm" | grep -q 200

step "ownership: second user cannot publish over dummy"
$BEVARA logout
$BEVARA adduser -u bob
cd "$WORK/dummy"
node -e "const f='bevara.json',m=JSON.parse(require('fs').readFileSync(f));m.version='1.2.0';require('fs').writeFileSync(f,JSON.stringify(m,null,2))"
expect_fail $BEVARA publish -y
$BEVARA login --password -u alice
$BEVARA owner add bob dummy
$BEVARA owner ls dummy | grep -q bob
$BEVARA login --password -u bob
$BEVARA publish -y
$BEVARA unpublish dummy@1.2.0 -y
$BEVARA logout
expect_fail $BEVARA whoami

echo
echo "E2E OK"
