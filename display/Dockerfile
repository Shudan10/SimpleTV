# The TV screen: a full-screen browser showing SimpleTV's home screen.
#
# TV mode (a machine that is only a TV box): cage, a kiosk Wayland compositor,
# takes over the screen directly, and PipeWire plays sound out of HDMI.
# Window mode (a desktop that is also a TV box sometimes): the browser opens
# full-screen on the desktop's own display and plays through its sound.
FROM debian:trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg \
        cage seatd \
        pipewire pipewire-pulse wireplumber pipewire-alsa dbus dbus-user-session \
        pulseaudio-utils \
        x11-xserver-utils \
        mesa-va-drivers mesa-vulkan-drivers libgl1-mesa-dri libegl1 \
        fonts-noto-core fonts-noto-color-emoji \
        util-linux procps tini \
    && rm -rf /var/lib/apt/lists/*

# Brave: Chromium underneath, so it plays what Chrome plays (Widevine, for
# Netflix, Prime Video, Disney+ and the rest, comes as a component it fetches
# once the entrypoint has switched it on), and its Shields block ads and
# trackers -- YouTube's included -- without an extension.
RUN curl -fsSL https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg \
        -o /usr/share/keyrings/brave-browser-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg] https://brave-browser-apt-release.s3.brave.com/ stable main" \
        > /etc/apt/sources.list.d/brave-browser-release.list \
    && apt-get update && apt-get install -y --no-install-recommends brave-browser \
    && ln -s /usr/bin/brave-browser /usr/local/bin/simpletv-browser \
    && rm -rf /var/lib/apt/lists/*

# Nothing on a TV can answer a prompt or a promotion, so Brave's extras
# (analytics, rewards, wallet, VPN, AI chat, Tor) are switched off by policy.
COPY policies.json /etc/brave/policies/managed/simpletv.json

# The browser runs as this user, never as root, so its sandbox stays on. The
# entrypoint gives it the uid of the person who installed SimpleTV.
RUN useradd --create-home --uid 1000 --shell /usr/sbin/nologin simpletv

COPY entrypoint.sh /usr/local/bin/simpletv-display
RUN chmod 0755 /usr/local/bin/simpletv-display

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/simpletv-display"]
