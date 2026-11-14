# Lounge's server. No npm dependencies: everything is the Node standard
# library, so there is no dependency tree to install or audit.
FROM node:22-alpine

# pactl drives the volume (PipeWire speaks the PulseAudio protocol). The docker
# CLI is for updating Lounge from its Settings page and for closing the TV
# window, both of which happen in containers the server starts.
RUN apk add --no-cache \
    pulseaudio-utils \
    docker-cli \
    docker-cli-compose \
    docker-cli-buildx \
    curl \
    tini

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public

# Each connected controller holds a thread of the pool in a blocking read.
ENV NODE_ENV=production \
    PORT=8480 \
    DATA_DIR=/data \
    UV_THREADPOOL_SIZE=16

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
