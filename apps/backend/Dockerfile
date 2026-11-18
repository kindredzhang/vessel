# Pinned to the toolchain in go.mod; the -alpine variant is not always published.
FROM golang:1.27 AS build
WORKDIR /src

# Cache the module graph separately from the source. GOPROXY is a build arg so
# networks that cannot reach proxy.golang.org (or CI caches) can override it.
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${VERSION}" \
    -o /out/vesseld ./cmd/vesseld

# A scratch image, on purpose: the binary is static (CGO_ENABLED=0), so the only
# things it needs are CA roots and a non-root uid. scratch also builds without
# any package-manager network access, which makes offline/CI builds reliable.
FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/vesseld /usr/local/bin/vesseld
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/vesseld"]
