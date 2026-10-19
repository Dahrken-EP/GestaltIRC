#!/usr/bin/env bash
# The native voice stack against a real browser: starts a bouncer and a scripted IRC network, runs the desktop app
# (a debug build, driven by its own signing-in driver) with fake audio, and has Chromium join the same voice room.
#
#   npm --prefix web run build
#   (cd desktop/src-tauri && cargo build)
#   test/native/run.sh            # voice: both directions of audio, mute, leave, rejoin
#   test/native/run.sh transfer   # a direct chat with a file each way (MB=20 megabytes by default)
#
# Needs Go, Node, Python 3, xvfb-run, Playwright (set PLAYWRIGHT_MODULE to its path if it is not global) and a
# Chromium (CHROMIUM_PATH, or one Playwright installed). No sound server is needed: GESTALT_MEDIA_FAKE_AUDIO gives
# the app a tone for a microphone and nowhere to play.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
bouncer_port=${BOUNCER_PORT:-18280}
irc_port=${IRC_PORT:-16780}
password='a-long-password-1'
scenario=${1:-voice}
case "$scenario" in voice|transfer) ;; *) echo "usage: $0 [voice|transfer]" >&2; exit 2;; esac
app="$root/desktop/src-tauri/target/debug/gestalt-desktop"
pids=()

cleanup() {
  for pid in "${pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

for port in "$bouncer_port" "$irc_port"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "port $port is already in use; stop whatever is listening, or set BOUNCER_PORT and IRC_PORT" >&2
    exit 2
  fi
done
[ -f "$root/web/dist/index.html" ] || { echo "web/dist is missing. Run: npm --prefix web run build" >&2; exit 2; }
[ -x "$app" ] || { echo "$app is missing. Run: (cd desktop/src-tauri && cargo build)" >&2; exit 2; }

echo "building the bouncer"
(cd "$root/server" && go build -o "$work/bouncer" ./cmd/bouncer)
cat > "$work/bouncer.yaml" <<YAML
listen: "127.0.0.1:$bouncer_port"
web_dir: "$root/web/dist"
data_dir: "$work/data"
allow_private_networks: true
secret_key_file: "$work/data/secret.key"
YAML
chmod 600 "$work/bouncer.yaml"
b() { "$work/bouncer" -config "$work/bouncer.yaml" "$@"; }
b init > /dev/null
for u in matt jane; do
  echo "$password" | b user add "$u" > /dev/null
  b network add "$u" fake --host 127.0.0.1 --port "$irc_port" --nick "$u" --join '#chat' > /dev/null
done

IRC_PORT=$irc_port python3 -I "$root/test/e2e/fake_irc.py" > "$work/irc.log" 2>&1 &
pids+=($!)
"$work/bouncer" -config "$work/bouncer.yaml" serve > "$work/bouncer.log" 2>&1 &
pids+=($!)
for _ in $(seq 1 50); do
  curl -fs "http://127.0.0.1:$bouncer_port/" > /dev/null 2>&1 && break
  sleep 0.2
done
sleep 6 # the bouncer connects to the scripted network a few seconds after it starts

if [ -z "${CHROMIUM_PATH:-}" ]; then
  for c in "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux/chrome; do
    [ -x "$c" ] && export CHROMIUM_PATH="$c" && break
  done
fi

# The app, with a home of its own and the server already chosen.
home="$work/home"
mkdir -p "$home/config/net.gestalt.desktop"
printf '{"mode":"remote","url":"http://127.0.0.1:%s/","port":0,"user":"","close_to_tray":false}' "$bouncer_port" > "$home/config/net.gestalt.desktop/settings.json"

if [ "$scenario" = voice ]; then
  # Chromium joins first and waits; the app signs in as matt, joins, mutes, leaves and joins again.
  BASE_URL="http://127.0.0.1:$bouncer_port" TEST_PASSWORD="$password" node "$here/interop.cjs" > "$work/browser.log" 2>&1 &
  browser=$!
  sleep 8
  env -u WAYLAND_DISPLAY -u XDG_RUNTIME_DIR \
    HOME="$home" XDG_CONFIG_HOME="$home/config" XDG_DATA_HOME="$home/data" XDG_CACHE_HOME="$home/cache" \
    GESTALT_MEDIA_FAKE_AUDIO=1 GESTALT_MEDIA_LIVE="matt:$password" WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    timeout 80 xvfb-run -a "$app" > "$work/app.log" 2>&1 &
  appid=$!
  pids+=($appid)
else
  # The app is given a script to run in its window (a debug build feature); it signs in as matt, asks jane for a direct
  # chat, sends a file and takes one back. Chromium is jane.
  mb=${MB:-20}
  sed -e "s/__MB__/$mb/" -e "s/__PASS__/$password/" "$here/transfer-desktop.js" > "$work/transfer-desktop.js"
  MB=$mb BASE_URL="http://127.0.0.1:$bouncer_port" TEST_PASSWORD="$password" node "$here/transfer.cjs" > "$work/browser.log" 2>&1 &
  browser=$!
  sleep 6
  env -u WAYLAND_DISPLAY -u XDG_RUNTIME_DIR \
    HOME="$home" XDG_CONFIG_HOME="$home/config" XDG_DATA_HOME="$home/data" XDG_CACHE_HOME="$home/cache" \
    GESTALT_MEDIA_FAKE_AUDIO=1 GESTALT_EVAL_JS="$work/transfer-desktop.js" GESTALT_EVAL_SECS="${EVAL_SECS:-600}" WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    timeout "${EVAL_SECS:-600}" xvfb-run -a "$app" > "$work/app.log" 2>&1 &
  appid=$!
  pids+=($appid)
fi

status=0
wait "$browser" || status=$?
if [ "$scenario" = transfer ]; then
  # Give the app a moment to put its last findings on the log, then read them.
  sleep 4
fi
kill "$appid" 2>/dev/null || true
cat "$work/browser.log"

if [ "$scenario" = voice ]; then
  # From the app's side: the other implementation's audio really arrived and was decoded.
  if grep -q "the first packet arrived" "$work/app.log"; then
    echo "ok  : the desktop app decoded the browser's audio (the first packet arrived)"
  else
    echo "FAIL: the desktop app never decoded a packet from the browser"
    status=1
  fi
else
  last=$(grep '^PROBE' "$work/app.log" | tail -1 || true)
  echo "desktop app saw: ${last#PROBE }"
  if echo "$last" | grep -q '\\"error\\"'; then echo "FAIL: the desktop app reported an error"; status=1; fi
  if ! echo "$last" | grep -q 'received'; then echo "FAIL: the desktop app did not finish the exchange"; status=1; fi
fi
if [ "$status" -ne 0 ]; then
  echo "--- app log"; grep -E "^(media:|PROBE)" "$work/app.log" | grep -v "driver got" | tail -25
  echo "--- bouncer log"; tail -15 "$work/bouncer.log"
fi
exit "$status"
