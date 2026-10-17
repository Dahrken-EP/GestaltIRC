#!/usr/bin/env bash
# Runs the browser tests: builds the bouncer, starts it next to a scripted IRC
# network, and drives the built web client in Chromium. Everything lives in a
# temporary directory that is removed afterwards.
#
#   npm --prefix web run build     # once, and after changing the client
#   test/e2e/run.sh
#
#   VOICE_LOAD=1 test/e2e/run.sh   # ten browsers in one voice room instead (slower)
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
site_port=${SITE_PORT:-18081}
password='a-long-password-1'
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

# A leftover process on one of the ports would answer instead of the ones started here,
# and the tests would quietly run against old code.
for port in "$bouncer_port" "$irc_port" "$site_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is already in use; stop whatever is listening, or set BOUNCER_PORT, IRC_PORT and SITE_PORT" >&2
    exit 2
  fi
done

if [ ! -f "$root/web/dist/index.html" ]; then
  echo "web/dist is missing. Run: npm --prefix web run build" >&2
  exit 2
fi

# The e2e tag lets the media proxy reach the test site on this machine. A normal
# build forbids that, and this tag is never used for a real one.
echo "building the bouncer"
(cd "$root/server" && go build -tags e2e -o "$work/bouncer" ./cmd/bouncer)

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
# A second person, for the tests where two browsers talk to each other.
echo "$password" | b user add jane > /dev/null
b network add jane fake --host 127.0.0.1 --port "$irc_port" --nick jane --join '#chat' > /dev/null
echo "$password" | b user add kim > /dev/null
b network add kim fake --host 127.0.0.1 --port "$irc_port" --nick kim --join '#chat' > /dev/null
if [ -n "${VOICE_LOAD:-}" ]; then
  # Eleven more people for the voice room load test: ten fit, the eleventh is turned away.
  for i in $(seq -w 1 11); do
    echo "$password" | b user add "u$i" > /dev/null
    b network add "u$i" fake --host 127.0.0.1 --port "$irc_port" --nick "u$i" --join '#chat' > /dev/null
  done
fi

IRC_PORT=$irc_port python3 -I "$here/fake_irc.py" &
pids+=($!)
SITE_PORT=$site_port python3 -I "$here/site.py" &
pids+=($!)
# Started directly, not through the b() helper: a function in the background runs in a
# subshell, so its PID is not the bouncer's, and cleanup would leave the bouncer running.
"$work/bouncer" -config "$work/bouncer.yaml" serve > "$work/bouncer.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$bouncer_port/" > /dev/null 2>&1 && break
  sleep 0.2
done
# The bouncer connects to the network a few seconds after it starts.
sleep 6

# Playwright's headless shell does not honour a notification permission grant, which the push test
# needs, so prefer a full Chromium when one is installed.
if [ -z "${CHROMIUM_PATH:-}" ]; then
  for c in "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux/chrome; do
    [ -x "$c" ] && export CHROMIUM_PATH="$c" && break
  done
fi

script=drive
[ -n "${VOICE_LOAD:-}" ] && script=voice_load
out=${OUT_DIR:-$work/out}
mkdir -p "$out"
status=0
BASE_URL="http://127.0.0.1:$bouncer_port" SITE_URL="http://127.0.0.1:$site_port" TEST_PASSWORD="$password" OUT_DIR="$out" \
  node "$here/$script.cjs" || status=$?
echo "screenshots: $out (removed on exit unless OUT_DIR is set)"
if [ "$status" -ne 0 ]; then echo "--- bouncer log"; tail -20 "$work/bouncer.log"; fi
exit "$status"
