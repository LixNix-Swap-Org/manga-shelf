#!/bin/sh
# deb: remove | upgrade | deconfigure, rpm: 0 (erase) or 1 (upgrade); only a real removal stops the service
set -e
case "$1" in
    remove|0)
        if [ -d /run/systemd/system ]; then
            systemctl disable --now manga-shelf.service >/dev/null 2>&1 || true
        fi
        ;;
esac
