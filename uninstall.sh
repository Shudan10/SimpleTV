#!/usr/bin/env bash
# Removes Lounge. Says exactly what goes before anything does.
set -euo pipefail

DIR="${LOUNGE_DIR:-$HOME/.lounge}"
KEEP_DATA=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
    case "$1" in
        --keep-data) KEEP_DATA=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --dir) DIR="$2"; shift 2 ;;
        *) echo "Usage: uninstall.sh [--keep-data] [--yes] [--dir <path>]" >&2; exit 2 ;;
    esac
done

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker); fi
fi

echo "This removes:"
echo "  - the containers lounge-server, lounge-tv and lounge-window"
echo "  - the images lounge/server:1 and lounge/display:1"
if [ "$KEEP_DATA" = 1 ]; then
    echo "  (keeping the volumes lounge-data, lounge-browser and lounge-audio, so a reinstall picks up where you left off)"
else
    echo "  - the volume lounge-data: settings, home screen order, paired phones, the Jellyfin sign-in"
    echo "  - the volume lounge-browser: the TV browser's profile, so every sign-in on it"
    echo "    (Netflix, YouTube, Prime Video, ...) is forgotten"
    echo "  - the volume lounge-audio"
fi
echo "  - the folder $DIR"
echo "  - ~/.local/bin/lounge, and the Lounge entries in your apps menu and autostart"
echo "Nothing else is touched. Docker itself stays installed."
echo

if [ "$ASSUME_YES" != 1 ]; then
    if [ -r /dev/tty ]; then
        printf 'Remove all of that? [y/N] ' > /dev/tty
        read -r answer < /dev/tty || answer=""
    else
        answer=""
    fi
    case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing was removed."; exit 0 ;; esac
fi

"${DOCKER[@]}" rm -f lounge-window lounge-tv lounge-server lounge-update >/dev/null 2>&1 || true
"${DOCKER[@]}" rmi lounge/server:1 lounge/display:1 >/dev/null 2>&1 || true
if [ "$KEEP_DATA" != 1 ]; then
    "${DOCKER[@]}" volume rm lounge-data lounge-browser lounge-audio >/dev/null 2>&1 || true
fi
rm -f "$HOME/.local/bin/lounge" "$HOME/.local/share/applications/lounge.desktop" "$HOME/.config/autostart/lounge.desktop"
rm -rf "$DIR"
echo "Lounge is removed."
