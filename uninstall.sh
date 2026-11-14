#!/usr/bin/env bash
# Removes SimpleTV. Says exactly what goes before anything does.
set -euo pipefail

DIR="${SIMPLETV_DIR:-$HOME/.simpletv}"
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

# Only ever a SimpleTV folder: never a home folder, never one with other
# things in it that merely has the name given.
DIR="$(cd "$DIR" 2>/dev/null && pwd -P || printf '%s' "$DIR")"
case "$DIR" in
    /|"$HOME"|"$(cd "$HOME" && pwd -P)"|/home|/root|/usr|/etc|/var|/opt|"") echo "Refusing to remove $DIR." >&2; exit 1 ;;
esac
if [ -d "$DIR" ] && { [ ! -f "$DIR/.env" ] || [ ! -f "$DIR/docker-compose.yml" ] || [ ! -f "$DIR/uninstall.sh" ]; }; then
    echo "$DIR does not look like a SimpleTV install (no .env, docker-compose.yml and uninstall.sh), so it is left alone." >&2
    echo "Point --dir at the folder SimpleTV is installed in." >&2
    exit 1
fi

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
    if command -v sudo >/dev/null && sudo docker info >/dev/null 2>&1; then DOCKER=(sudo docker); fi
fi

echo "This removes:"
echo "  - the containers simpletv-server, simpletv-tv and simpletv-window"
echo "  - the volume simpletv-input (only the pipe the phone's touchpad uses)"
echo "  - the images simpletv/server:1 and simpletv/display:1"
if [ "$KEEP_DATA" = 1 ]; then
    echo "  (keeping the volumes simpletv-data, simpletv-browser and simpletv-audio, so a reinstall picks up where you left off)"
else
    echo "  - the volume simpletv-data: settings, home screen order, paired phones, the Jellyfin sign-in"
    echo "  - the volume simpletv-browser: the TV browser's profile, so every sign-in on it"
    echo "    (Netflix, YouTube, Prime Video, ...) is forgotten"
    echo "  - the volume simpletv-audio"
fi
echo "  - the folder $DIR"
echo "  - ~/.local/bin/simpletv, and the SimpleTV entries in your apps menu and autostart"
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

"${DOCKER[@]}" rm -f simpletv-window simpletv-tv simpletv-server simpletv-update >/dev/null 2>&1 || true
"${DOCKER[@]}" rmi simpletv/server:1 simpletv/display:1 >/dev/null 2>&1 || true
"${DOCKER[@]}" volume rm simpletv-input >/dev/null 2>&1 || true
if [ "$KEEP_DATA" != 1 ]; then
    "${DOCKER[@]}" volume rm simpletv-data simpletv-browser simpletv-audio >/dev/null 2>&1 || true
fi
rm -f "$HOME/.local/bin/simpletv" "$HOME/.local/share/applications/simpletv.desktop" "$HOME/.config/autostart/simpletv.desktop"
rm -rf "$DIR"
echo "SimpleTV is removed."
