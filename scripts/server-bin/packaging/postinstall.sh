#!/bin/sh
# deb: configure, rpm: 1 (install) or 2 (upgrade)
set -e
if ! getent passwd manga-shelf >/dev/null 2>&1; then
    if command -v useradd >/dev/null 2>&1; then
        useradd --system --user-group --home-dir /var/lib/manga-shelf --no-create-home --shell /usr/sbin/nologin manga-shelf
    else
        adduser --system --group --home /var/lib/manga-shelf --no-create-home --shell /usr/sbin/nologin manga-shelf
    fi
fi
mkdir -p /var/lib/manga-shelf
chown manga-shelf:manga-shelf /var/lib/manga-shelf
chmod 750 /var/lib/manga-shelf
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable manga-shelf.service >/dev/null 2>&1 || true
    systemctl restart manga-shelf.service || true
    echo "Manga Shelf Server läuft auf Port 3000 (Einstellungen: /var/lib/manga-shelf/.env)."
    echo "Einrichtungscode und Logs: journalctl -u manga-shelf -n 50"
fi
