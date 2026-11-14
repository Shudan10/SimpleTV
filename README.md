# Lounge

A TV home screen for a computer plugged into a TV. Rows of apps, what you were
watching on Jellyfin, search, and settings, all driven from the couch with your
phone or a game controller. Open source, runs in Docker, installs with one line.

```bash
curl -fsSL https://raw.githubusercontent.com/Shudan10/Lounge/main/install.sh | bash
```

## Two ways to run it

The installer picks one by looking at the computer:

| | **Window mode** | **TV mode** |
|---|---|---|
| For | A desktop that is plugged into the TV some of the time | A computer that is only a TV box |
| The screen | A full-screen window, opened from the Lounge icon or `lounge open` | Lounge takes over the screen at boot, like a streaming stick |
| Sound | Through the desktop's sound | Its own PipeWire, out of HDMI |
| Back to the desktop | Settings → Display → Close Lounge, or `lounge close` | There is no desktop |

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
- **Keyboard and mouse** work too.

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

## The `lounge` command

```
lounge open | close | status | logs | restart | remote | update | uninstall
```

Settings → About & updates also updates Lounge from the TV.

## How it works

Three containers, all on the host's network:

- `lounge-server` (Node, no npm dependencies): serves the home screen and the
  phone remote, reads game controllers straight from `/dev/input`, and plays
  every button press into the TV's browser over the DevTools protocol. That is
  why the remote and controller work on any website, not just Lounge's own pages.
- `lounge-tv` or `lounge-window`: Brave in kiosk mode, under the `cage` Wayland
  compositor in TV mode, or as a window on the desktop's X display. The browser
  runs as an ordinary user with its sandbox on.

Settings live in the `lounge-data` volume, the browser's sign-ins in
`lounge-browser`. `uninstall.sh` lists everything it removes before it does.

## Uninstall

```bash
lounge uninstall              # or: bash ~/.lounge/uninstall.sh
lounge uninstall --keep-data  # keep settings and sign-ins for a reinstall
```

## Licence

MIT
