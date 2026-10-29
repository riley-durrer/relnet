#!/usr/bin/env bash
# Live demo helper: two companies on one laptop, driven by a published release (RELNET_VERSION, default below). No Aztec toolchain, no
# sandbox, no chain: this is the invite / join / negotiate part only. Works with bash 3.2 (macOS) and on Linux.
#
#   scripts/live.sh prep        download and check the release (once), then set up a FRESH deal:
#                               invite, join, accept, and the buyer's agent left running, waiting for offers
#   scripts/live.sh show        print both companies' price limits
#   scripts/live.sh floor 530   the supplier's person changes their lowest price (in cents)
#   scripts/live.sh go          the supplier's agent negotiates with the buyer's, right now
#
# A deal can be negotiated once. Run `prep` again for a fresh one (fast after the first time).
# Needs: node 24, npm, curl, tar, and for the download checks the GitHub CLI 2.49+ logged in (SKIP_ATTEST=1 skips that).
set -euo pipefail
LIVE="${LIVE:-$HOME/relnet-live}"
V="${RELNET_VERSION:-0.1.1}"; REPO="riley-durrer/relnet"; PORT="${PORT:-4871}"
TREE="$LIVE/relnet-$V"
BASE="https://github.com/$REPO/releases/download/v$V"
say() { printf '\n== %s\n' "$*"; }
rn() { # rn <home> <args...> : run the relnet CLI from the release as one company
  local home="$1"; shift
  (cd "$TREE" && RELNET_HOME="$home" LOG_LEVEL=silent npm run -s relnet -- "$@")
}
current() { cat "$LIVE/current" 2>/dev/null || { echo "run '$0 prep' first" >&2; exit 1; }; }
fp_after() { awk '/agent key fingerprint:/{getline; gsub(/ /,""); print; exit}' "$1"; }

case "${1:-}" in
prep)
  mkdir -p "$LIVE/dl"
  if [ ! -f "$LIVE/dl/relnet-$V.tgz" ]; then
    say "download relnet v$V from GitHub"
    (cd "$LIVE/dl" && curl -sfLO "$BASE/relnet-$V.tgz" -O "$BASE/SHA256SUMS" -O "$BASE/relnet-$V.release.json")
  fi
  say "check the download"
  (cd "$LIVE/dl" && { command -v sha256sum >/dev/null && sha256sum -c SHA256SUMS || shasum -a 256 -c SHA256SUMS; })
  if [ -z "${SKIP_ATTEST:-}" ]; then
    (cd "$LIVE/dl" && gh attestation verify "relnet-$V.tgz" --repo "$REPO" >/dev/null && echo "attestation OK: built by $REPO's release workflow")
  else
    echo "attestation check skipped (SKIP_ATTEST is set)"
  fi
  if [ ! -d "$TREE" ]; then
    say "unpack and install (about a minute the first time)"
    tar -xzf "$LIVE/dl/relnet-$V.tgz" -C "$LIVE"
    (cd "$TREE" && npm ci --ignore-scripts >/dev/null 2>&1) || { echo "npm ci failed" >&2; exit 1; }
  fi
  # stop a previous run's buyer agent (only the one this script started)
  # (the [t] keeps pkill from matching its own command line)
  pkill -f "[t]sx src/cli/relnet.ts serve --deal .* --port $PORT" 2>/dev/null || true; rm -f "$LIVE/serve.pid"
  say "set up a fresh deal"
  RUN="$LIVE/run-$(date +%s)"; mkdir -p "$RUN/buyer" "$RUN/supplier"
  cp "$TREE/examples/companies/lone-star-assembly/mandate.json" "$LIVE/buyer.mandate.json"
  cp "$TREE/examples/companies/trinity-castings/mandate.json" "$LIVE/supplier.mandate.json"
  rn "$RUN/buyer" invite --side buyer --url "http://127.0.0.1:$PORT" > "$RUN/invite.txt" 2> "$RUN/invite.err"
  ID="$(sed -n 's/^Deal \([0-9a-f]*\)\..*/\1/p' "$RUN/invite.err" | head -1)"; FPB="$(fp_after "$RUN/invite.err")"
  echo "buyer (Lone Star) invited the supplier: deal $ID"
  rn "$RUN/supplier" join "$(cat "$RUN/invite.txt")" --confirm-fingerprint "$FPB" > "$RUN/reply.txt" 2> "$RUN/join.err"
  FPS="$(fp_after "$RUN/join.err")"
  echo "supplier (Trinity) joined and pinned the buyer's agent key"
  rn "$RUN/buyer" accept "$(cat "$RUN/reply.txt")" --deal "$ID" --confirm-fingerprint "$FPS" > /dev/null 2> "$RUN/accept.err"
  echo "buyer pinned the supplier's agent key"
  cd "$TREE"
  RELNET_HOME="$RUN/buyer" LOG_LEVEL=silent nohup npm run -s relnet -- serve --deal "$ID" --mandate "$LIVE/buyer.mandate.json" --port "$PORT" > "$RUN/serve.log" 2>&1 < /dev/null &
  cd "$LIVE"
  for _ in $(seq 1 60); do grep -q "Serving deal" "$RUN/serve.log" 2>/dev/null && break; sleep 0.5; done
  grep -q "Serving deal" "$RUN/serve.log" || { echo "buyer agent did not start:"; cat "$RUN/serve.log"; exit 1; }
  echo "$RUN" > "$LIVE/current"; echo "$ID" > "$RUN/deal"
  echo "buyer's agent is running and waiting for offers"
  say "ready. Next: '$0 show', then '$0 floor <cents>', then '$0 go'"
  ;;
show)
  node -e '
    const fs=require("fs"), L=process.argv[1];
    for (const [n,f] of [["Lone Star (buyer)","buyer"],["Trinity (supplier)","supplier"]]) {
      const m=JSON.parse(fs.readFileSync(`${L}/${f}.mandate.json`)), p=m.ranges.price_cents;
      console.log(`${n.padEnd(20)} price per unit: $${(p.min/100).toFixed(2)} to $${(p.max/100).toFixed(2)}`);
    }' "$LIVE"
  ;;
floor)
  [ -n "${2:-}" ] || { echo "usage: $0 floor <cents>   e.g. $0 floor 530" >&2; exit 64; }
  node -e '
    const fs=require("fs"), f=process.argv[1]+"/supplier.mandate.json", m=JSON.parse(fs.readFileSync(f));
    m.ranges.price_cents.min=process.argv[2]; fs.writeFileSync(f, JSON.stringify(m,null,2)+"\n");
    console.log(`Trinity\x27s lowest price is now $${(Number(process.argv[2])/100).toFixed(2)}`);' "$LIVE" "$2"
  ;;
go)
  RUN="$(current)"; ID="$(cat "$RUN/deal")"
  echo "The supplier's agent (Trinity) opens negotiations with the buyer's agent (Lone Star)."
  set +e
  rn "$RUN/supplier" negotiate --deal "$ID" --mandate "$LIVE/supplier.mandate.json"
  rc=$?
  set -e
  [ $rc -eq 0 ] || echo "(no agreement; run '$0 prep' for a fresh deal)"
  exit $rc
  ;;
*) sed -n '2,13p' "$0"; exit 64 ;;
esac
