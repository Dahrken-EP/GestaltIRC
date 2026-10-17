#!/usr/bin/env bash
# Measures the web client's JavaScript heap against the budget in DESIGN.md section 9: 10 channels open
# with their history loaded. Needs the built client (npm --prefix web run build), Node, Python and Playwright
# (see test/e2e/README.md). MSGS is how many messages each channel holds (default 2000, the history limit).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
port=${BOUNCER_PORT:-18095}
irc_port=${IRC_PORT:-16695}
msgs=${MSGS:-2000}
password='a-long-password-1'
pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT

for p in "$port" "$irc_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then echo "port $p is in use" >&2; exit 2; fi
done
[ -f "$root/web/dist/index.html" ] || { echo "web/dist is missing. Run: npm --prefix web run build" >&2; exit 2; }

(cd "$root/server" && go build -o "$work/bouncer" ./cmd/bouncer)
cat > "$work/bouncer.yaml" <<YAML
listen: "127.0.0.1:$port"
web_dir: "$root/web/dist"
data_dir: "$work/data"
secret_key_file: "$work/data/secret.key"
YAML
chmod 600 "$work/bouncer.yaml"
b() { "$work/bouncer" -config "$work/bouncer.yaml" "$@"; }
b init > /dev/null
echo "$password" | b user add matt > /dev/null
b network add matt fake --host 127.0.0.1 --port "$irc_port" --nick matt --join '#load1,#load2,#load3,#load4,#load5,#load6,#load7,#load8,#load9,#load10' > /dev/null

LOAD_MSGS=$msgs IRC_PORT=$irc_port python3 -I "$root/test/e2e/fake_irc.py" &
pids+=($!)
"$work/bouncer" -config "$work/bouncer.yaml" serve > "$work/bouncer.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do curl -fs "http://127.0.0.1:$port/" > /dev/null 2>&1 && break; sleep 0.2; done
sleep 8

if [ -z "${CHROMIUM_PATH:-}" ]; then
  for c in "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux/chrome; do
    [ -x "$c" ] && export CHROMIUM_PATH="$c" && break
  done
fi
BASE_URL="http://127.0.0.1:$port" TEST_PASSWORD="$password" MSGS="$msgs" node "$here/webheap.cjs"
