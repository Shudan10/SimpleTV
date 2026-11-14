#!/bin/sh
# Starts the TV screen. Runs as root only long enough to set things up; the
# browser itself runs as the 'simpletv' user with its sandbox on.
set -eu

MODE="${SIMPLETV_MODE:-window}"
URL="${SIMPLETV_URL:-http://127.0.0.1:8480/tv/}"
CDP_PORT="${CDP_PORT:-9222}"
RUNTIME=/run/simpletv-xdg
UID_WANT="${HOST_UID:-1000}"
GID_WANT="${HOST_GID:-1000}"

say() { echo "simpletv-display: $*"; }

# The browser runs with the uid of whoever installed SimpleTV: in window mode
# that is what lets it reach their display and their sound.
if [ "$(id -g simpletv)" != "$GID_WANT" ]; then groupmod -o -g "$GID_WANT" simpletv; fi
if [ "$(id -u simpletv)" != "$UID_WANT" ]; then usermod -o -u "$UID_WANT" -g "$GID_WANT" simpletv >/dev/null; fi

# Whatever groups own the GPU and sound devices on this host, by number.
for dev in /dev/dri/* /dev/snd/*; do
    [ -e "$dev" ] || continue
    gid=$(stat -c %g "$dev")
    [ "$gid" = 0 ] && continue
    name=$(getent group "$gid" | cut -d: -f1 || true)
    if [ -z "$name" ]; then
        name="host$gid"
        groupadd -o -g "$gid" "$name"
    fi
    id -nG simpletv | tr ' ' '\n' | grep -qx "$name" || usermod -aG "$name" simpletv
done

mkdir -p /browser/profile "$RUNTIME"
chmod 0700 "$RUNTIME"
chown "$UID_WANT:$GID_WANT" "$RUNTIME"
[ "$(stat -c %u /browser/profile)" = "$UID_WANT" ] || chown -R "$UID_WANT:$GID_WANT" /browser

# Brave asks before fetching Widevine, the module DRM video needs. On a TV
# there is nobody to click that prompt, so the answer is given up front.
if [ ! -f /browser/profile/"Local State" ]; then
    printf '%s\n' '{"brave":{"widevine_opted_in":true,"p3a":{"enabled":false,"notice_acknowledged":true},"stats":{"reporting_enabled":false}}}' \
        > /browser/profile/"Local State"
    chown "$UID_WANT:$GID_WANT" /browser/profile/"Local State"
fi

# Never bring back the last session. Started with the home screen's address,
# Brave would open it next to whatever the last session had -- which was the
# home screen too -- so every Close and reopen stacked one more copy behind
# the one on screen. Each keeps a connection to the server, and at six the
# browser has none left: nothing loads and everything waits.
rm -rf /browser/profile/Default/Sessions "/browser/profile/Default/Current Session" \
    "/browser/profile/Default/Current Tabs" "/browser/profile/Default/Last Session" \
    "/browser/profile/Default/Last Tabs"

# The browser's last session ending in a crash or a power cut is normal on a
# TV; never offer to restore it.
prefs=/browser/profile/Default/Preferences
if [ -f "$prefs" ]; then
    sed -i 's/"exit_type":"[A-Za-z]*"/"exit_type":"Normal"/; s/"exited_cleanly":false/"exited_cleanly":true/' "$prefs" || true
fi

# Websites see a 1920-wide screen, as on a 1080p TV, whatever the display's
# real resolution and the desktop's scaling: a laptop at 200% would hand them
# 1200 pixels (everything huge), a 4K TV at 100% 3840 (everything tiny).
# Website size in Settings nudges it (0.85 smaller, 1.15 larger).
SITE_SCALE=1
[ -r /run/simpletv-input/site-scale ] && SITE_SCALE=$(tr -dc '0-9.' < /run/simpletv-input/site-scale)
scale_for() { # physical width in pixels -> device scale factor
    awk -v w="$1" -v s="${SITE_SCALE:-1}" 'BEGIN { if (w <= 0) w = 1920; if (s <= 0) s = 1; f = w / 1920 * s; if (f < 0.5) f = 0.5; if (f > 4) f = 4; printf "%.3f", f }'
}

FLAGS="--kiosk
--user-data-dir=/browser/profile
--remote-debugging-port=$CDP_PORT
--no-first-run
--no-default-browser-check
--password-store=basic
--noerrdialogs
--disable-infobars
--disable-session-crashed-bubble
--hide-crash-restore-bubble
--disable-translate
--disable-features=Translate,MediaRouter,DialMediaRouteProvider
--autoplay-policy=no-user-gesture-required
--overscroll-history-navigation=0
--disable-pinch
--check-for-update-interval=31536000
--enable-features=AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL,VaapiVideoDecoder
--ignore-gpu-blocklist"


if [ "$MODE" = tv ]; then
    say "TV mode: taking over the screen"
    # Sound: PipeWire, with its PulseAudio socket on the volume the server
    # also mounts, so the server can set the volume.
    mkdir -p "$RUNTIME/pulse"
    chown "$UID_WANT:$GID_WANT" "$RUNTIME/pulse"
    rm -f "$RUNTIME/pulse/native" "$RUNTIME/pulse/pid"

    # seatd hands the screen and input devices to cage without cage being root.
    rm -f /run/seatd.sock
    seatd -u simpletv -g simpletv &
    n=0
    while [ ! -S /run/seatd.sock ]; do
        n=$((n + 1)); [ "$n" -gt 50 ] && { say "seatd did not start"; exit 1; }
        sleep 0.1
    done

    TV_WIDTH=1920
    for st in /sys/class/drm/card*-*/status; do
        [ "$(cat "$st" 2>/dev/null)" = connected ] || continue
        mode=$(head -n1 "$(dirname "$st")/modes" 2>/dev/null)
        [ -n "$mode" ] && TV_WIDTH=${mode%%x*} && break
    done
    FLAGS="$FLAGS
--force-device-scale-factor=$(scale_for "$TV_WIDTH")"

    # shellcheck disable=SC2086
    exec setpriv --reuid="$UID_WANT" --regid="$GID_WANT" --init-groups \
        env HOME=/home/simpletv USER=simpletv XDG_RUNTIME_DIR="$RUNTIME" \
            LIBSEAT_BACKEND=seatd WLR_LIBINPUT_NO_DEVICES=1 \
            PULSE_SERVER="unix:$RUNTIME/pulse/native" \
        dbus-run-session -- sh -c '
            pipewire & sleep 0.5
            wireplumber & pipewire-pulse &
            exec cage -s -- simpletv-browser --ozone-platform=wayland "$@"
        ' sh $FLAGS "$URL"
fi

# Window mode: full-screen on the desktop's display. With the desktop
# session's bus, the browser's "keep the screen on" reaches the desktop, so
# it neither locks nor blanks while SimpleTV is open.
BUS_ENV=""
[ -S /run/simpletv-session-bus ] && BUS_ENV="DBUS_SESSION_BUS_ADDRESS=unix:path=/run/simpletv-session-bus"

# The phone's touchpad moves the desktop's real pointer: the server writes
# moves and clicks into this pipe, and xdotool plays them on the display.
# Only these words and whole numbers are acted on; anything else is ignored.
# The real pointer reaches what a pointer drawn into the page cannot: sign-in
# sheets in the page's top layer, other sites' frames, drop-down menus.
PIPE_DIR=/run/simpletv-input
if [ -d "$PIPE_DIR" ]; then
    rm -f "$PIPE_DIR/pointer"
    mkfifo -m 0600 "$PIPE_DIR/pointer"
    # Read by the browser's user; the server writes as root.
    chown "$UID_WANT:$GID_WANT" "$PIPE_DIR/pointer"
    setpriv --reuid="$UID_WANT" --regid="$GID_WANT" --init-groups \
        env HOME=/home/simpletv DISPLAY="${DISPLAY:-:0}" sh -c '
            num() { case "$1" in ""|*[!0-9-]*|-*-*|?*-*) return 1 ;; esac; }
            while :; do
                while read -r verb a b; do
                    case "$verb" in
                        move) num "$a" && num "$b" && xdotool mousemove_relative -- "$a" "$b" ;;
                        click) xdotool click 1 ;;
                        up) xdotool click 4 ;;
                        down) xdotool click 5 ;;
                        left) xdotool click 6 ;;
                        right) xdotool click 7 ;;
                        zoomin|zoomout|zoomreset)
                            # To the SimpleTV window, wherever the keyboard focus was.
                            w=$(xdotool search --onlyvisible --class brave 2>/dev/null | tail -n 1)
                            [ -n "$w" ] && xdotool windowactivate --sync "$w" 2>/dev/null
                            case "$verb" in
                                zoomin) xdotool key --clearmodifiers ctrl+equal ;;
                                zoomout) xdotool key --clearmodifiers ctrl+minus ;;
                                zoomreset) xdotool key --clearmodifiers ctrl+0 ;;
                            esac ;;
                    esac
                done < '"$PIPE_DIR/pointer"'
            done' >/dev/null 2>&1 &
fi
say "window mode: opening on display ${DISPLAY:-?}"
pos=""
if command -v xrandr >/dev/null 2>&1 && monitors=$(xrandr --listmonitors 2>/dev/null); then
    # Lines look like: " 1: +*HDMI-1 3840/1600x2160/900+2560+0  HDMI-1"
    pick=$(printf '%s\n' "$monitors" | awk -v want="${SIMPLETV_SCREEN:-auto}" '
        NR == 1 { next }
        {
            name = $NF; geo = $3; primary = ($2 ~ /\*/)
            split(geo, p, /[x+]/); split(p[1], w, "/"); split(p[2], h, "/")
            line = w[1] " " h[1] " " p[3] " " p[4]
            idx = NR - 2
            if (want == name || want == idx) { print line; found = 1; exit }
            if (!hdmi && name ~ /HDMI/) hdmi = line
            if (primary && !prim) prim = line
            if (!first) first = line
        }
        END { if (!found) { if (want == "auto" && hdmi) print hdmi; else if (prim) print prim; else print first } }')
    if [ -n "$pick" ]; then
        set -- $pick
        # Window size and position are in scaled pixels once a scale is forced.
        f=$(scale_for "$1")
        pos=$(awk -v w="$1" -v h="$2" -v x="$3" -v y="$4" -v f="$f" 'BEGIN { printf "--window-size=%d,%d --window-position=%d,%d --force-device-scale-factor=%s", w/f+0.5, h/f+0.5, x/f+0.5, y/f+0.5, f }')
        say "using the screen at $3,$4 ($1x$2)"
    fi
fi

# shellcheck disable=SC2086
exec setpriv --reuid="$UID_WANT" --regid="$GID_WANT" --init-groups \
    env HOME=/home/simpletv USER=simpletv XDG_RUNTIME_DIR="$RUNTIME" DISPLAY="${DISPLAY:-:0}" \
        PULSE_SERVER="unix:$RUNTIME/pulse/native" $BUS_ENV \
    simpletv-browser --ozone-platform=x11 $pos $FLAGS "$URL"
