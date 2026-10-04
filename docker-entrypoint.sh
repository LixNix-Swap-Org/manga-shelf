#!/bin/sh
# A bind-mounted data folder is often owned by root (created by the Docker daemon) or by the host user.
# Started as root, hand it to `node` and drop privileges; started with --user, run unchanged.
set -e

if [ "$(id -u)" = "0" ]; then
    data_dir="${DATA_DIR:-/app/data}"
    mkdir -p "$data_dir"
    if [ -n "$(find "$data_dir" ! -user node 2>/dev/null | head -n 1)" ]; then
        echo "[entrypoint] Setze Besitzer von $data_dir auf node (uid $(id -u node))"
        chown -R node:node "$data_dir" || echo "[entrypoint] WARNUNG: chown von $data_dir fehlgeschlagen; der Ordner muss für uid $(id -u node) beschreibbar sein" >&2
    fi
    exec su-exec node "$@"
fi

exec "$@"
