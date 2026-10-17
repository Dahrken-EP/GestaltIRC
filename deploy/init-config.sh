#!/bin/sh
# Runs once in a throwaway container (the "setup" service in docker-compose.yml) and fills the config
# volume with settings made from the templates and a fresh TURN secret. A file that is already there is
# never touched, so editing the copy in the volume is safe, and so is starting the stack again.
#
# Needs: DOMAIN, TURN_HOST, ADMIN_EMAIL. Optional: PUBLIC_IP.
set -eu

fail() { echo "init-config: $*" >&2; exit 1; }

# These end up in YAML and coturn config, so keep to what is safe there.
safe() {
  case "$2" in
    ''|*[!A-Za-z0-9._@+-]*) fail "$1 is empty or has characters that are not allowed: '$2'" ;;
  esac
}
: "${DOMAIN:?set DOMAIN}"
TURN_HOST=${TURN_HOST:-$DOMAIN}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@$DOMAIN}
PUBLIC_IP=${PUBLIC_IP:-}
safe DOMAIN "$DOMAIN"
safe TURN_HOST "$TURN_HOST"
safe ADMIN_EMAIL "$ADMIN_EMAIL"
[ -z "$PUBLIC_IP" ] || safe PUBLIC_IP "$PUBLIC_IP"

cd /config
umask 022

if [ ! -e turn_secret ]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > turn_secret
  echo "init-config: made turn_secret"
fi
secret=$(cat turn_secret)

if [ ! -e bouncer.yaml ]; then
  sed -e "s|@ADMIN_EMAIL@|$ADMIN_EMAIL|g" -e "s|@TURN_HOST@|$TURN_HOST|g" /templates/bouncer.yaml.template > bouncer.yaml
  echo "init-config: made bouncer.yaml"
fi

if [ ! -e turnserver.conf ]; then
  ext=""
  [ -z "$PUBLIC_IP" ] || ext="external-ip=$PUBLIC_IP"
  sed -e "s|@TURN_HOST@|$TURN_HOST|g" -e "s|@TURN_SECRET@|$secret|g" -e "s|@EXTERNAL_IP_LINE@|$ext|g" /templates/turnserver.conf.template > turnserver.conf
  echo "init-config: made turnserver.conf"
fi

# The bouncer and coturn run as unprivileged users in their own containers and must be able to read these.
# The volume is not published anywhere; whoever can read it on the host can already read the database.
chmod 644 turn_secret bouncer.yaml turnserver.conf
