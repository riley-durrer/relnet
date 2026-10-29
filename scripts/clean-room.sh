#!/usr/bin/env bash
# Follows the README quick start on a machine with nothing installed except Node and git: a fresh container,
# a fresh clone of the public repository, the Aztec toolchain from the official installer, then npm install,
# sandbox, build, tests and the demo. Everything is timed and logged. Needs Docker on the host.
#   scripts/clean-room.sh [branch-or-tag]   (default: main)   Output: clean-room.log in the current folder.
set -uo pipefail
REF="${1:-main}"
LOG="$PWD/clean-room.log"
: > "$LOG"
docker run --rm -i node:24-bookworm bash -s "$REF" 2>&1 <<'INNER' | tee "$LOG"
set -uo pipefail
REF="$1"
step() { echo; echo "=== [$(date +%H:%M:%S)] $*"; }
fail() { echo "!!! FAILED: $*"; exit 1; }
t0=$(date +%s)
step "machine"; node -v; npm -v; git --version | head -1; command -v docker >/dev/null && echo "docker: present" || echo "docker: NOT present in this container"

step "clone"; git clone --quiet --depth 1 --branch "$REF" https://github.com/riley-durrer/relnet.git /work && cd /work || fail clone
git log --oneline | head -1

step "README prerequisite: Aztec toolchain 5.2.1 (official installer)"
NON_INTERACTIVE=1 VERSION=5.2.1 bash <(curl -fsSL https://install.aztec.network) > /tmp/aztec-install.log 2>&1 || { tail -20 /tmp/aztec-install.log; fail "aztec installer"; }
export PATH="$HOME/.aztec/current/bin:$HOME/.aztec/current/node_modules/.bin:$HOME/.aztec/current/internal-bin:$HOME/.aztec/bin:$PATH"
aztec --version 2>&1 | head -1

step "npm install"; npm install > /tmp/npm-install.log 2>&1 || { tail -20 /tmp/npm-install.log; fail "npm install"; }
tail -3 /tmp/npm-install.log

step "npm run sandbox (background)"; (npm run sandbox > /tmp/sandbox.log 2>&1 &)
ready=0
for i in $(seq 1 120); do
  if curl -fs -m 3 -X POST localhost:8080 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' >/dev/null 2>&1; then ready=1; break; fi
  sleep 3
done
[ "$ready" = 1 ] && echo "sandbox answered after about $((i*3)) s" || { tail -30 /tmp/sandbox.log; fail "sandbox did not start within 6 minutes"; }

step "npm run build"; npm run build > /tmp/build.log 2>&1 || { tail -30 /tmp/build.log; fail "build"; }
tail -3 /tmp/build.log

step "npm test"; LOG_LEVEL=silent npm test > /tmp/test.log 2>&1; echo "npm test exit: $?"
grep -E "^[0-9]+ passed|FAIL" /tmp/test.log | sort | uniq -c

step "npm run demo"; LOG_LEVEL=silent timeout 900 npm run demo > /tmp/demo.log 2>&1; echo "demo exit: $?"
tail -12 /tmp/demo.log

step "done in $(( $(date +%s) - t0 )) s"
INNER
