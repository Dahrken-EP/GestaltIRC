#!/usr/bin/env bash
# Runs the browser tests: builds the bouncer, starts it next to a scripted IRC
# network, and drives the built web client in Chromium. Everything lives in a
# temporary directory that is removed afterwards.
#
#   npm --prefix web run build     # once, and after changing the client
#   test/e2e/run.sh
#
# Needs Go, Node, Python 3 and Playwright (npm i -g playwright, or set
# PLAYWRIGHT_MODULE to its path). Set CHROMIUM_PATH to use a Chromium you
# already have instead of Playwright's own.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
bouncer_port=${BOUNCER_PORT:-18080}
irc_port=${IRC_PORT:-16667}
password='a-long-password-1'
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

if [ ! -f "$root/web/dist/index.html" ]; then
  echo "web/dist is missing. Run: npm --prefix web run build" >&2
  exit 2
fi

echo "building the bouncer"
(cd "$root/server" && go build -o "$work/bouncer" ./cmd/bouncer)

cat > "$work/bouncer.yaml" <<YAML
listen: "127.0.0.1:$bouncer_port"
web_dir: "$root/web/dist"
data_dir: "$work/data"
secret_key_file: "$work/data/secret.key"
YAML
chmod 600 "$work/bouncer.yaml"

b() { "$work/bouncer" -config "$work/bouncer.yaml" "$@"; }
b init > /dev/null
echo "$password" | b user add matt > /dev/null
b network add matt fake --host 127.0.0.1 --port "$irc_port" --nick matt --join '#chat,#bulk' > /dev/null

IRC_PORT=$irc_port python3 -I "$here/fake_irc.py" &
pids+=($!)
b serve > "$work/bouncer.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$bouncer_port/" > /dev/null 2>&1 && break
  sleep 0.2
done
# The bouncer connects to the network a few seconds after it starts.
sleep 6

out=${OUT_DIR:-$work/out}
mkdir -p "$out"
status=0
BASE_URL="http://127.0.0.1:$bouncer_port" TEST_PASSWORD="$password" OUT_DIR="$out" \
  node "$here/drive.cjs" || status=$?
echo "screenshots: $out (removed on exit unless OUT_DIR is set)"
if [ "$status" -ne 0 ]; then echo "--- bouncer log"; tail -20 "$work/bouncer.log"; fi
exit "$status"
