#!/usr/bin/env bash
# Builds what the desktop app carries with it for local mode: the bouncer, for the platform being built, and
# the web client. Run before `tauri build`. Set GOOS and GOARCH to build for another platform.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
out="$here/src-tauri/resources"
mkdir -p "$out"

echo "building the web client"
npm --prefix "$root/web" ci --silent
npm --prefix "$root/web" run build --silent
rm -rf "$out/web"
cp -r "$root/web/dist" "$out/web"

exe=bouncer
if [ "${GOOS:-$(go env GOOS)}" = windows ]; then exe=bouncer.exe; fi
echo "building the bouncer ($exe)"
(cd "$root/server" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$out/$exe" ./cmd/bouncer)
