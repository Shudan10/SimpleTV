#!/usr/bin/env bash
#
# One-command installer for SimpleTV, a TV home screen for a computer plugged
# into a TV.
#
#   curl -fsSL https://raw.githubusercontent.com/Shudan10/SimpleTV/main/install.sh | bash
#
# Installs Docker if it is missing, fetches SimpleTV into ~/.simpletv, builds it
# and starts it. Two ways to run it, picked automatically:
#
#   window  This computer has a desktop. SimpleTV opens as a full-screen window
#           from its icon (or `simpletv open`), and closes back to the desktop.
#   tv      This computer has no desktop. SimpleTV takes over the screen at boot
#           and is all the TV shows, like a streaming stick.
#
# Everything it creates lives in one folder and a handful of docker objects,
# all removable with uninstall.sh.

set -euo pipefail

REPO="${SIMPLETV_REPO:-Shudan10/SimpleTV}"
REF="${SIMPLETV_REF:-main}"
DIR="${SIMPLETV_DIR:-$HOME/.simpletv}"
PORT="${SIMPLETV_PORT:-8480}"
MODE="${SIMPLETV_MODE:-auto}"
SCREEN_PICK="${SIMPLETV_SCREEN:-auto}"
# A local checkout to install from instead of GitHub, for trying changes.
SOURCE_DIR="${SIMPLETV_SOURCE_DIR:-}"
ASSUME_YES="${SIMPLETV_YES:-0}"
AUTOSTART=0

while [ $# -gt 0 ]; do
    case "$1" in
        --mode) MODE="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --dir) DIR="$2"; shift 2 ;;
        --screen) SCREEN_PICK="$2"; shift 2 ;;
        --repo) REPO="$2"; shift 2 ;;
        --ref) REF="$2"; shift 2 ;;
        --from) SOURCE_DIR="$2"; shift 2 ;;
        --autostart) AUTOSTART=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h)
            cat <<'USAGE'
Usage: install.sh [options]

  --mode tv|window   tv: this computer is only a TV box, SimpleTV takes over the
                     screen at boot. window: SimpleTV is a full-screen window on
                     this desktop. Picked automatically if not given.
  --port <port>      Port for the home screen and phone remote (default 8480)
  --screen <name>    Window mode: which screen to open on, by output name
                     (HDMI-1) or number. Default: an HDMI screen if there is
                     one, else the main screen.
  --autostart        Window mode: open SimpleTV when you log in
  --dir <path>       Where to install (default ~/.simpletv)
  --from <path>      Install from a local copy instead of GitHub
  --yes, -y          Do not ask questions
USAGE
            exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

if [ -t 1 ]; then
    B=$'\033[1m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; R=$'\033[0m'
else
    B=""; RED=""; GRN=""; YLW=""; CYN=""; R=""
fi
say()  { printf '%s==>%s %s\n' "$CYN" "$R" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$R" "$*" >&2; }
die()  { printf '%sfail%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

# Questions go to the terminal even when this script arrives through a pipe.
ask() {
    local prompt="$1" answer
    [ "$ASSUME_YES" = 1 ] && return 0
    [ -r /dev/tty ] || return 0
    printf '%s [y/N] ' "$prompt" > /dev/tty
    read -r answer < /dev/tty || return 1
    case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

[ "$(uname -s)" = Linux ] || die "SimpleTV runs on Linux: it drives the screen of the computer it is installed on."
[ "$(id -u)" -ne 0 ] || die "Run this as your own user, not root. It asks for sudo when it needs it."
command -v curl >/dev/null || die "curl is required."
command -v tar >/dev/null || die "tar is required."
case "$(uname -m)" in
    x86_64|amd64) ;;
    aarch64|arm64) warn "On ARM, SimpleTV uses Chromium, which cannot play Netflix, Prime Video, Disney+ and other DRM services. YouTube and Jellyfin work." ;;
    *) die "Unsupported CPU: $(uname -m)" ;;
esac
SUDO=""
command -v sudo >/dev/null && SUDO=sudo

# ------------------------------------------------------------------ docker --

DOCKER=(docker)

docker_reachable() {
    timeout 15 "${DOCKER[@]}" info >/dev/null 2>&1
}

resolve_docker() {
    command -v docker >/dev/null || return 1
    DOCKER=(docker)
    docker_reachable && return 0
    if [ -n "$SUDO" ]; then
        DOCKER=("$SUDO" docker)
        docker_reachable && return 0
    fi
    return 1
}

# Ubuntu derivatives (Mint, Pop!_OS, Zorin) carry the Ubuntu release they are
# built on; get.docker.com does not always pick it, so use it directly.
detect_apt_repo() {
    command -v apt-get >/dev/null || return 0
    [ -r /etc/os-release ] || return 0
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
        ubuntu) echo "ubuntu ${VERSION_CODENAME:-}" ;;
        debian) echo "debian ${VERSION_CODENAME:-}" ;;
        *)
            if [ -n "${UBUNTU_CODENAME:-}" ]; then echo "ubuntu $UBUNTU_CODENAME"
            elif [ -n "${DEBIAN_CODENAME:-}" ]; then echo "debian $DEBIAN_CODENAME"
            fi ;;
    esac
}

install_docker() {
    [ -n "$SUDO" ] || die "Installing Docker needs sudo."
    local repo flavour codename
    repo="$(detect_apt_repo)"
    flavour="${repo%% *}"
    codename="${repo##* }"
    if [ -n "$flavour" ] && [ -n "$codename" ] && [ "$flavour" != "$codename" ]; then
        say "Installing Docker from Docker's $flavour '$codename' repository"
        $SUDO install -m 0755 -d /etc/apt/keyrings
        $SUDO curl -fsSL "https://download.docker.com/linux/$flavour/gpg" -o /etc/apt/keyrings/docker.asc
        $SUDO chmod a+r /etc/apt/keyrings/docker.asc
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$flavour $codename stable" \
            | $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
        $SUDO apt-get -qq update
        $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
            docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
            || die "Installing Docker failed."
    else
        say "Installing Docker (get.docker.com)"
        local script; script="$(mktemp)"
        curl -fsSL https://get.docker.com -o "$script" || die "Could not download the Docker installer."
        $SUDO sh "$script" || die "The Docker installer failed."
        rm -f "$script"
    fi
    $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
    $SUDO usermod -aG docker "$USER" >/dev/null 2>&1 \
        && warn "Added $USER to the docker group; it takes effect at your next login. Until then sudo is used."
}

say "Checking Docker"
if ! resolve_docker; then
    command -v docker >/dev/null && die "Docker is installed but not running. Start it (sudo systemctl start docker) and run this again."
    ask "Docker is not installed. Install it now?" || die "SimpleTV needs Docker."
    install_docker
    for _ in $(seq 1 60); do resolve_docker && break; sleep 2; done
    resolve_docker || die "Docker did not come up."
fi
"${DOCKER[@]}" compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command). Install docker-compose-plugin."
ok "Docker is ready${DOCKER[1]:+ (through sudo)}"

# -------------------------------------------------------------------- mode --

graphical_session() {
    [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && return 0
    systemctl is-active --quiet display-manager 2>/dev/null && return 0
    loginctl list-sessions --no-legend 2>/dev/null | awk '{print $1}' | while read -r s; do
        loginctl show-session "$s" -p Type --value 2>/dev/null
    done | grep -qE 'x11|wayland'
}

if [ -f "$DIR/.env" ] && [ "$MODE" = auto ]; then
    MODE="$(sed -n 's/^SIMPLETV_MODE=//p' "$DIR/.env")"
    [ -n "$MODE" ] || MODE=auto
fi
if [ "$MODE" = auto ]; then
    if graphical_session; then MODE=window; else MODE=tv; fi
fi
case "$MODE" in
    window) say "Window mode: SimpleTV opens full-screen on this desktop and closes back to it." ;;
    tv)
        say "TV mode: SimpleTV takes over this computer's screen at every boot."
        if graphical_session; then
            warn "This computer is running a desktop. TV mode and a desktop fight over the screen."
            warn "Use --mode window here, or turn the desktop off first."
            ask "Install in TV mode anyway?" || die "Stopped. Run again with --mode window to use SimpleTV on this desktop."
        fi
        ;;
    *) die "--mode must be tv or window." ;;
esac

# --------------------------------------------------------------- fetch ----

ITEMS="server display docker-compose.yml install.sh uninstall.sh simpletv README.md LICENSE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
SHA=""
if [ -n "$SOURCE_DIR" ]; then
    say "Copying SimpleTV from $SOURCE_DIR"
    for item in $ITEMS; do [ -e "$SOURCE_DIR/$item" ] && cp -a "$SOURCE_DIR/$item" "$tmp/"; done
    SHA="$(git -C "$SOURCE_DIR" rev-parse HEAD 2>/dev/null || true)"
else
    say "Downloading $REPO@$REF"
    SHA="$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null || true)"
    curl -fsSL "https://codeload.github.com/$REPO/tar.gz/${SHA:-$REF}" | tar -xz -C "$tmp" --strip-components=1 \
        || die "Could not download SimpleTV from GitHub."
fi
[ -f "$tmp/docker-compose.yml" ] || die "That does not look like SimpleTV."

mkdir -p "$DIR/conf"
for item in $ITEMS; do
    [ -e "$tmp/$item" ] || continue
    rm -rf "$DIR/$item.new"
    cp -a "$tmp/$item" "$DIR/$item.new"
    rm -rf "$DIR/$item"
    mv "$DIR/$item.new" "$DIR/$item"
done
chmod +x "$DIR/simpletv" "$DIR/install.sh" "$DIR/uninstall.sh" 2>/dev/null || true
[ -n "$SHA" ] && echo "$SHA" > "$DIR/conf/installed-sha"
ok "SimpleTV is in $DIR"

# ----------------------------------------------------------------- .env ----

tz="$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)"
if [ "$MODE" = window ]; then
    runtime="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    if [ -S "$runtime/pulse/native" ]; then
        AUDIO_SOURCE="$runtime/pulse"
    else
        AUDIO_SOURCE="audio"
        warn "No sound server found at $runtime/pulse; the volume buttons will not work until there is one."
    fi
    PROFILES=""
else
    AUDIO_SOURCE="audio"
    PROFILES="tv"
fi
cat > "$DIR/.env" <<EOF
# Written by install.sh. Run it again to change these.
SIMPLETV_MODE=$MODE
SIMPLETV_PORT=$PORT
SIMPLETV_SCREEN=$SCREEN_PICK
SIMPLETV_REPO=$REPO
COMPOSE_PROFILES=$PROFILES
STACK_HOST=$DIR
HOST_HOME=$HOME
HOST_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
HOST_UID=$(id -u)
HOST_GID=$(id -g)
HOST_DISPLAY=${DISPLAY:-:0}
AUDIO_SOURCE=$AUDIO_SOURCE
TZ=$tz
EOF
chmod 600 "$DIR/.env"

# --------------------------------------------------------- build and run ----

cd "$DIR"
say "Building (the first time downloads the Brave browser; a few minutes)"
"${DOCKER[@]}" compose --profile tv --profile window build server tv \
    || die "The build failed. The output above says why."
say "Starting"
"${DOCKER[@]}" compose up -d --remove-orphans || die "SimpleTV did not start."

for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 || die "SimpleTV started but is not answering on port $PORT. See: docker logs simpletv-server"
ok "SimpleTV is running"

# The simpletv command.
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/simpletv" "$HOME/.local/bin/simpletv"

if [ "$MODE" = window ]; then
    apps="$HOME/.local/share/applications"
    mkdir -p "$apps"
    cat > "$apps/simpletv.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SimpleTV
Comment=TV home screen
Exec=$DIR/simpletv open
Icon=$DIR/server/public/tv/icon.svg
Terminal=false
Categories=AudioVideo;Video;
EOF
    if [ "$AUTOSTART" = 1 ]; then
        mkdir -p "$HOME/.config/autostart"
        sed "s|^Exec=.*|Exec=$DIR/simpletv open --wait|" "$apps/simpletv.desktop" > "$HOME/.config/autostart/simpletv.desktop"
        ok "SimpleTV opens when you log in"
    fi
    ok "Added SimpleTV to your apps menu"
else
    $SUDO systemctl enable docker >/dev/null 2>&1 || true
fi

ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") print $(i+1)}')"
echo
printf '%sSimpleTV is installed.%s\n\n' "$B" "$R"
if [ "$MODE" = window ]; then
    echo "  Open it:       the SimpleTV icon in your apps menu, or run:  simpletv open"
    echo "  Close it:      Settings > Display > Close SimpleTV, or run:  simpletv close"
else
    echo "  It is on the TV now, and starts with this computer from now on."
fi
echo "  Phone remote:  scan the code in Settings > Phone remote, or open"
echo "                 http://${ip:-this-computer}:$PORT/remote/ on your phone"
echo "  Controllers:   plug one in or pair it over Bluetooth; it just works"
echo
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "Add ~/.local/bin to your PATH to use the 'simpletv' command (or log out and back in)." ;; esac
if [ "$MODE" = window ] && [ "$ASSUME_YES" != 1 ] && [ -r /dev/tty ] && ask "Open SimpleTV now?"; then
    "$DIR/simpletv" open
fi
