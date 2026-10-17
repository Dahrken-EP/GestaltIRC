#!/usr/bin/env bash
# Measures the bouncer's memory against the budget in DESIGN.md section 9, using the real binary.
#
#   test/load/run.sh                 # 1 user, then 50 users with 2 networks and 20 channels each
#   USERS=10 MSGS=50 test/load/run.sh
#
# A scripted IRC network (test/e2e/fake_irc.py) stands in for the upstream: it puts MSGS old
# messages into each channel as it is joined. Memory is the resident set size from /proc.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
port=${BOUNCER_PORT:-18090}
irc_port=${IRC_PORT:-16690}
users=${USERS:-50}
nets=${NETS:-2}
chans=${CHANNELS:-20}
msgs=${MSGS:-100}
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

echo "building the bouncer"
(cd "$root/server" && go build -o "$work/bouncer" ./cmd/bouncer)

cat > "$work/bouncer.yaml" <<YAML
listen: "127.0.0.1:$port"
data_dir: "$work/data"
secret_key_file: "$work/data/secret.key"
YAML
chmod 600 "$work/bouncer.yaml"
b() { "$work/bouncer" -config "$work/bouncer.yaml" "$@"; }
b init > /dev/null

rss_kb() { awk '/VmRSS/{print $2}' "/proc/$1/status"; }
mb() { awk -v k="$1" 'BEGIN{printf "%.1f", k/1024}'; }

join_list=$(seq -s, 1 "$chans" | sed 's/\([0-9]\+\)/#load\1/g')

add_user() {
  local name=$1 count=$2
  echo "$password" | b user add "$name" > /dev/null
  for n in $(seq 1 "$count"); do
    b network add "$name" "n$n" --host 127.0.0.1 --port "$irc_port" --nick "$name" --join "$join_list" > /dev/null
  done
}

LOAD_MSGS=$msgs IRC_PORT=$irc_port python3 -I "$root/test/e2e/fake_irc.py" &
pids+=($!)
sleep 1

wait_http() {
  for _ in $(seq 1 100); do
    curl -fs "http://127.0.0.1:$port/" > /dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "the bouncer did not start" >&2
  exit 1
}

# --- A: one user, one network, nothing happening ---
add_user u01 1
"$work/bouncer" -config "$work/bouncer.yaml" serve > "$work/bouncer.log" 2>&1 &
bpid=$!
pids+=($bpid)
wait_http
sleep 15
idle=$(rss_kb "$bpid")
echo "idle, 1 user, 1 network, $chans channels with $msgs messages each: $(mb "$idle") MB   (budget 25 MB for the bare process)"
kill "$bpid"; wait "$bpid" 2>/dev/null || true

# --- B: the full population ---
for i in $(seq 2 "$users"); do add_user "$(printf 'u%02d' "$i")" "$nets"; done
# u01 has one network so far; give it the rest.
for n in $(seq 2 "$nets"); do
  b network add u01 "n$n" --host 127.0.0.1 --port "$irc_port" --nick u01 --join "$join_list" > /dev/null
done
"$work/bouncer" -config "$work/bouncer.yaml" serve > "$work/bouncer.log" 2>&1 &
bpid=$!
pids+=($bpid)
wait_http
echo "waiting for $((users * nets)) networks to connect and fill their history"
for _ in $(seq 1 120); do
  connected=$(grep -c "started network" "$work/bouncer.log" || true)
  [ "$connected" -ge $((users * nets)) ] && break
  sleep 1
done
# Done when the database has stopped growing: every network is connected and has taken its history.
last=-1; same=0
for _ in $(seq 1 300); do
  size=$(du -sk "$work/data" | cut -f1)
  if [ "$size" = "$last" ]; then same=$((same + 1)); else same=0; fi
  last=$size
  [ "$same" -ge 8 ] && break
  sleep 1
done
loaded=$(rss_kb "$bpid")
db=$(du -sk "$work/data" | cut -f1)
echo "$users users x $nets networks x $chans channels x $msgs messages, nobody attached: $(mb "$loaded") MB   (database on disk: $(mb "$db") MB)"

# --- C: a client attached to every network, as if everyone opened the web client ---
CHANNELS=$chans HOLD_MS=${HOLD_MS:-8000} BASE_URL="ws://127.0.0.1:$port/ws" TEST_PASSWORD="$password" node "$here/clients.cjs" "$users" "$nets" > "$work/clients.out" 2> "$work/clients.err" &
cpid=$!
for _ in $(seq 1 120); do
  [ -s "$work/clients.out" ] && break
  kill -0 "$cpid" 2>/dev/null || break
  sleep 1
done
if [ ! -s "$work/clients.out" ]; then cat "$work/clients.err" >&2; echo "clients failed" >&2; exit 1; fi
attached=$(rss_kb "$bpid")
echo "$(cat "$work/clients.out")"
echo "with $((users * nets)) clients attached: $(mb "$attached") MB   (budget 300 MB for the population)"
wait "$cpid" 2>/dev/null || true
sleep 2
after=$(rss_kb "$bpid")
echo "after they all left: $(mb "$after") MB"
fds=$(ls "/proc/$bpid/fd" | wc -l)
echo "open file descriptors: $fds"
