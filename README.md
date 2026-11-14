# SimpleTV

A TV home screen for a computer plugged into a TV. Rows of apps, what you were
watching on Jellyfin, search, and settings, all driven from the couch with your
phone or a game controller. Open source, runs in Docker, installs with one line.

```bash
curl -fsSL https://raw.githubusercontent.com/Shudan10/SimpleTV/main/install.sh | bash
```

## Two ways to run it

The installer picks one by looking at the computer:

| | **Window mode** | **TV mode** |
|---|---|---|
| For | A desktop that is plugged into the TV some of the time | A computer that is only a TV box |
| The screen | A full-screen window, opened from the SimpleTV icon or `simpletv open` | SimpleTV takes over the screen at boot, like a streaming stick |
| Sound | Through the desktop's sound | Its own PipeWire, out of HDMI |
| Back to the desktop | Settings → Display → Close SimpleTV, or `simpletv close` | There is no desktop |

Force one with `--mode window` or `--mode tv`. TV mode wants a machine with no
desktop running: a minimal Debian or Ubuntu Server install is ideal.

## Controlling it

- **Phone:** open Settings → Phone remote and scan the code. The remote is a web
  page, so there is no app to install. It has a d-pad, a touchpad for websites
  made for a mouse, a keyboard that types on the TV as you type, and volume.
  Phones pair once with a six-digit code and can be removed from the same page.
- **Game controller:** Xbox, PlayStation, 8BitDo and the rest, by USB or Bluetooth.
  D-pad or left stick moves, A selects, B goes back, the Xbox or PS button goes
  home, and the right stick moves a pointer.
- **Keyboard and mouse** work too: arrows and Enter move and select, Esc goes
  back, and **Home** (or **Ctrl+H**) goes to the SimpleTV home screen from any app.

## Jellyfin, built in

Sign in once under Settings → Jellyfin (SimpleTV finds the server on your
network by itself) and your libraries appear under **Library**: poster grids,
a details page for every film and show with seasons and episodes, and
SimpleTV's own full-screen player.

- Files the TV can play as they are play untouched, in full quality; anything
  else (HEVC on a computer without a decoder for it, Dolby Digital audio, ...)
  Jellyfin converts on the fly.
- OK pauses, Left and Right skip ten seconds, Down reaches the buttons:
  subtitles, audio track, next episode, stop.
- Where you stop is sent back to Jellyfin, so Continue watching is the same on
  the TV, your phone and Jellyfin's own apps. A show rolls on into the next
  episode after a ten-second countdown.

## Screensaver, and a computer that stays awake

While SimpleTV is open, the computer does not lock, dim or go to sleep: the
browser holds the desktop's own screen-saver inhibit, the way a video player
does, and lets go when SimpleTV closes. Instead, after the minutes chosen in
Settings → Display, photos of the world from Wikimedia Commons (featured
pictures of landscapes, mountains, lakes and coasts, each credited) fade in over
whatever is on screen, with a clock that drifts so nothing burns in. Never while
something is playing. The first key, click, tap or controller press only wakes
the screen; everything is where it was.

## Apps

Every app is a website opened full-screen: YouTube (in its TV interface),
Netflix, Prime Video, Disney+, Max, Hulu, Apple TV, Paramount+, Peacock,
Crunchyroll, Tubi, Pluto TV, Twitch, Jellyfin, Plex, Spotify, YouTube Music,
Xbox Cloud Gaming and GeForce NOW. Any other website can be added as a tile.

The browser is **Brave**, so ads and trackers are blocked everywhere, YouTube's
included. YouTube works hard against ad blockers; Brave keeps up, but no blocker
is guaranteed to win every time.

**Streaming quality:** Netflix, Prime Video, Disney+ and other DRM services
play at up to 720p in any Linux browser. That is their licensing rule, not a
limit of the computer. Your own Jellyfin and YouTube play at full quality.

On ARM computers (a Raspberry Pi, say) DRM services do not play at all.

## The `simpletv` command

```
simpletv open | close | status | logs | restart | remote | update | uninstall
```

Settings → Updates also updates SimpleTV from the TV. The top bar has **Close**
(window mode: back to the desktop) and **Power** (turn the computer off or
restart it).

## How it works

Three containers, all on the host's network:

- `simpletv-server` (Node, no npm dependencies): serves the home screen and the
  phone remote, reads game controllers straight from `/dev/input`, and plays
  every button press into the TV's browser over the DevTools protocol. That is
  why the remote and controller work on any website, not just SimpleTV's own pages.
- `simpletv-tv` or `simpletv-window`: Brave in kiosk mode, under the `cage` Wayland
  compositor in TV mode, or as a window on the desktop's X display. The browser
  runs as an ordinary user with its sandbox on.

Settings live in the `simpletv-data` volume, the browser's sign-ins in
`simpletv-browser`. `uninstall.sh` lists everything it removes before it does.

## Uninstall

```bash
simpletv uninstall              # or: bash ~/.simpletv/uninstall.sh
simpletv uninstall --keep-data  # keep settings and sign-ins for a reinstall
```

## Licence

MIT
