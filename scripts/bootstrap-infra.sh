#!/usr/bin/env bash
# scripts/bootstrap-infra.sh
#
# Reproducibly provisions REAL infrastructure binaries (no root, no Docker)
# for the WORK-002 integration test suite:
#   - PostgreSQL 17 (initdb/postgres/psql)        [apt-get download]
#   - Redis 8       (redis-server/redis-cli)      [apt-get download]
#   - Minio         (S3-compatible object storage) [dl.min.io static binary]
#
# Binaries are extracted into .infra/ (gitignored) under the repo root. The
# script is idempotent: it skips any component whose binary is already
# present. Tests do not require Docker; they spawn these real servers on
# random local ports via tests/infra/harness.ts.
#
# Run: bash scripts/bootstrap-infra.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA="$ROOT/.infra"
mkdir -p "$INFRA"

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*" >&2; }
have() { [ -x "$1" ]; }

# ----------------------------------------------------------------------------
# Redis (real redis-server 8). The tree is kept because redis-server links
# liblzf.so.1 and libjemalloc from the extracted lib dir; the test harness
# sets LD_LIBRARY_PATH to that dir.
# ----------------------------------------------------------------------------
REDIS_BIN="$INFRA/redis-root/usr/bin/redis-server"
if ! have "$REDIS_BIN"; then
  log "fetching redis (apt-get download; no root)"
  cd "$INFRA"
  apt-get download redis-server redis-tools liblzf1 2>/dev/null
  for d in *.deb; do dpkg-deb -x "$d" "$INFRA/redis-root/" 2>/dev/null || true; done
  rm -f *.deb
fi
if have "$REDIS_BIN"; then
  LD_LIBRARY_PATH="$INFRA/redis-root/usr/lib/x86_64-linux-gnu" "$REDIS_BIN" --version >/dev/null 2>&1 \
    && log "redis: $(LD_LIBRARY_PATH="$INFRA/redis-root/usr/lib/x86_64-linux-gnu" "$REDIS_BIN" --version 2>&1 | head -1)" \
    || log "redis: binary present but libs unresolved (check LD_LIBRARY_PATH in harness)"
fi

# ----------------------------------------------------------------------------
# PostgreSQL 17 (real postgres/initdb/psql). The full extracted tree is
# kept because initdb locates its share/ (template + sample config files)
# relative to the binary layout; copying binaries out of the tree breaks
# initdb. The harness references pg-root/usr/lib/postgresql/17/bin/* and
# sets LD_LIBRARY_PATH to pg-root/usr/lib/x86_64-linux-gnu (libpq5 for psql).
# ----------------------------------------------------------------------------
PG_BIN="$INFRA/pg-root/usr/lib/postgresql/17/bin/postgres"
if ! have "$PG_BIN"; then
  log "fetching postgresql 17 (apt-get download; no root)"
  cd "$INFRA"
  apt-get download postgresql-17 postgresql-client-17 libpq5 ssl-cert 2>/dev/null
  for d in *.deb; do dpkg-deb -x "$d" "$INFRA/pg-root/" 2>/dev/null || true; done
  rm -f *.deb
fi
if have "$PG_BIN"; then
  log "postgres: $(${PG_BIN} --version 2>&1 | head -1)"
fi

# ----------------------------------------------------------------------------
# Minio (real S3-compatible server, static binary)
# ----------------------------------------------------------------------------
MINIO_BIN="$INFRA/minio/minio"
if ! have "$MINIO_BIN"; then
  log "fetching minio (dl.min.io static binary)"
  mkdir -p "$INFRA/minio"
  curl -fsSL -o "$INFRA/minio/minio" https://dl.min.io/server/minio/release/linux-amd64/minio
  chmod +x "$INFRA/minio/minio"
fi
if have "$MINIO_BIN"; then
  log "minio: $(${MINIO_BIN} --version 2>&1 | head -1)"
fi

log "done. binaries under $INFRA"
