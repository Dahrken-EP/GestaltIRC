# Gestalt: the bouncer and the web client in one small image.
#
#   docker build -t gestalt .
#   docker run -d --name gestalt -p 127.0.0.1:8080:8080 -v gestalt-data:/data gestalt
#
# That is enough to try it on your own machine (http://localhost:8080). For a real server, with HTTPS and
# the TURN relay that makes direct chat and voice work across NATs, use docker-compose.yml, which runs this
# image behind Caddy next to coturn.
#
# Ports
#   8080/tcp   the web client, its API and the WebSocket. Publish it to localhost, or put a TLS proxy in front;
#              do not expose it to the internet as plain HTTP.
# (The full stack in docker-compose.yml also uses 80/tcp and 443/tcp+udp for Caddy, 3478 udp+tcp and 5349/tcp
#  for coturn, and udp 49152-49252 for relayed media.)
#
# The first start with an empty /data volume creates the database and the secret key. Back both up together.
# Make the first user with:
#   echo 'a-long-password' | docker exec -i gestalt bouncer user add alice
# and give them a network with:
#   docker exec gestalt bouncer network add alice libera --host irc.libera.chat --port 6697 --tls --nick alice --join '#chat'
# (or add networks later from Settings in the web client).

# syntax=docker/dockerfile:1
# The base images are pinned by digest, so a build is the same build tomorrow and a changed upstream tag cannot
# slip in unseen. Dependabot proposes new digests weekly.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# The SQLite driver is pure Go, so the binary needs no C library and the final image needs no operating system.
# VERSION, when given, is the build the About page shows; without it the version in the source is kept.
ARG VERSION=""
RUN X=""; [ -z "$VERSION" ] || X="-X gestalt/server/internal/api.Version=$VERSION"; \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w $X" -o /out/bouncer ./cmd/bouncer \
 && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
LABEL org.opencontainers.image.title="Gestalt" \
      org.opencontainers.image.description="A self-hosted IRC bouncer with a compact web client" \
      org.opencontainers.image.source="https://github.com/Dahrken-EP/GestaltIRC"
COPY --from=server /out/bouncer /usr/local/bin/bouncer
COPY --from=web /src/web/dist /srv/web
# Settings that suit a container on its own. docker-compose.yml points GESTALT_CONFIG at its own file instead.
COPY deploy/bouncer.default.yaml /etc/gestalt/bouncer.yaml
# The data directory belongs to the unprivileged user, so a new volume is writable.
COPY --from=server --chown=65532:65532 /out/data /data
USER 65532:65532
ENV GESTALT_CONFIG=/etc/gestalt/bouncer.yaml \
    GESTALT_AUTO_INIT=1
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/bouncer", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/bouncer"]
CMD ["serve"]
