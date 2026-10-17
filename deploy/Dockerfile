# Builds the bouncer and the web client into one small image.
# Build context is the repository root:  docker build -f deploy/Dockerfile .
# syntax=docker/dockerfile:1

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
# The SQLite driver is pure Go, so the binary needs no C library.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bouncer ./cmd/bouncer \
 && mkdir /out/data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/bouncer /usr/local/bin/bouncer
COPY --from=web /src/web/dist /srv/web
# The data directory belongs to the unprivileged user, so a new volume is writable.
COPY --from=server --chown=65532:65532 /out/data /data
USER 65532:65532
EXPOSE 8080
VOLUME /data
ENTRYPOINT ["/usr/local/bin/bouncer", "-config", "/config/bouncer.yaml"]
CMD ["serve"]
