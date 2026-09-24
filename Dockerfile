# itsaresume in one image: the router, plus the `claude` CLI it drives.
#
# Build:  docker compose build     Run: docker compose up -d
# The Claude backend authenticates with CLAUDE_CODE_OAUTH_TOKEN (the
# subscription token from `claude setup-token`), passed at run time from a
# git-ignored .env file. Nothing secret is baked into the image.

FROM rust:1-slim-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked --bin itsaresume

FROM node:24-trixie-slim
# Pinned: the output format the router parses was observed on this version
# (docs/HANDOVER.md §4). Raise it deliberately, with a new observation.
ARG CLAUDE_CODE_VERSION=2.1.162
RUN npm install --global "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force
COPY --from=build /src/target/release/itsaresume /usr/local/bin/itsaresume
RUN mkdir -p /etc/itsaresume

# No self-update inside a pinned image, no non-essential network traffic.
ENV DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    ITSARESUME_CONFIG=/etc/itsaresume/config.toml

USER node
WORKDIR /home/node
RUN mkdir -p /home/node/journal

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
    CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT ["itsaresume"]
# Inside the container it must listen on every interface to be reachable at
# all; compose.yaml publishes it on the host's loopback only.
CMD ["serve", "--listen", "0.0.0.0:8787"]
