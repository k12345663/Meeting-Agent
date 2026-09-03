FROM node:22-slim

# build-essential + python3 are a safety net for better-sqlite3's native
# module — it ships prebuilt binaries for most platforms, these just make
# sure `npm install` still succeeds even if no prebuild matches this exact
# image, rather than failing the build.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# The SQLite file lives here — mount a persistent volume at this path on
# whatever host you use, or the admin list/settings reset on every deploy.
RUN mkdir -p /app/data
VOLUME /app/data

ENV PORT=4500
EXPOSE 4500

CMD ["node", "server.js"]
