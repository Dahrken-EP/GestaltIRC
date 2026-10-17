#!/usr/bin/env bash
# Creates the files docker-compose.yml needs, with fresh secrets.
#
#   DOMAIN=irc.example.org ADMIN_EMAIL=you@example.org ./setup.sh
#
# Optional: TURN_HOST (defaults to DOMAIN), PUBLIC_IP (the server's public address,
# needed for coturn when it sits behind NAT). It will not overwrite existing files.
set -euo pipefail

cd "$(dirname "$0")"
: "${DOMAIN:?set DOMAIN to the address people will visit, for example irc.example.org}"
: "${ADMIN_EMAIL:?set ADMIN_EMAIL; push services use it as the contact for this server}"
TURN_HOST=${TURN_HOST:-$DOMAIN}
PUBLIC_IP=${PUBLIC_IP:-}

# These end up inside YAML and coturn config, so keep to what is safe there.
safe() { [[ "$2" =~ ^[A-Za-z0-9._@+-]+$ ]] || { echo "$1 contains characters that are not allowed: $2" >&2; exit 1; }; }
safe DOMAIN "$DOMAIN"
safe ADMIN_EMAIL "$ADMIN_EMAIL"
safe TURN_HOST "$TURN_HOST"
[ -z "$PUBLIC_IP" ] || safe PUBLIC_IP "$PUBLIC_IP"

for f in .env bouncer.yaml turnserver.conf secrets/turn_secret; do
  if [ -e "$f" ]; then
    echo "$f already exists; remove it first if you want a new one" >&2
    exit 1
  fi
done

mkdir -p secrets
umask 077
secret=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')

printf '%s' "$secret" > secrets/turn_secret
printf 'DOMAIN=%s\n' "$DOMAIN" > .env

ext=""
[ -z "$PUBLIC_IP" ] || ext="external-ip=$PUBLIC_IP"
sed -e "s|@ADMIN_EMAIL@|$ADMIN_EMAIL|g" -e "s|@TURN_HOST@|$TURN_HOST|g" bouncer.yaml.template > bouncer.yaml
sed -e "s|@TURN_HOST@|$TURN_HOST|g" -e "s|@TURN_SECRET@|$secret|g" -e "s|@EXTERNAL_IP_LINE@|$ext|g" turnserver.conf.template > turnserver.conf
# The containers run as unprivileged users and must be able to read these files, so the
# files are readable, and the secrets directory keeps other users on this machine out.
chmod 644 bouncer.yaml secrets/turn_secret turnserver.conf
chmod 700 secrets

cat <<MSG
Wrote .env, bouncer.yaml, turnserver.conf and secrets/turn_secret.

Next:
  - Point $DOMAIN${TURN_HOST:+ and $TURN_HOST} at this server, and open ports 80, 443, 3478 (udp and tcp), 5349 and udp 49152-49252.
  - docker compose up -d
  - docker compose run --rm bouncer init
  - echo 'a-long-password' | docker compose run --rm -T bouncer user add YOURNAME
MSG
