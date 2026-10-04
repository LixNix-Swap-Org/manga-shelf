#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
fi
case "$1" in
    remove|purge|0)
        echo "Die Daten in /var/lib/manga-shelf und der Benutzer manga-shelf bleiben erhalten."
        ;;
esac
