<div align="center">

# Linerave

**A fork of [Liner](https://github.com/tryliner/desktop) with liveRave — an autonomous DJ engine that performs your playlists: beatmatched, phrase-aligned blends, jog moves, scratches and effects, on a virtual DDJ-REV7 stage.**

[![CI](https://img.shields.io/github/actions/workflow/status/Dream-byte-lab/desktop/ci.yml?branch=main&style=flat-square&label=CI&labelColor=0d0d10&logo=githubactions&logoColor=white)](https://github.com/Dream-byte-lab/desktop/actions/workflows/ci.yml) [![Platforms](https://img.shields.io/badge/platforms-Windows%20·%20Linux-2ec4b6?style=flat-square&labelColor=0d0d10)](#building) [![License](https://img.shields.io/badge/license-source--available-534dff?style=flat-square&labelColor=0d0d10)](./LICENSE)

[What this fork adds](#what-this-fork-adds) • [Preview](#preview) • [Architecture](#architecture) • [Getting Started](#getting-started) • [Building](#building) • [Docs](#docs) • [License](#license)

</div>

---

> [!NOTE]
> Linerave is a client of the official Liner API backend for music catalog, streaming playback, and synchronized lyrics — the same service the upstream app uses. This fork changes the client, not the service.

---

## What this fork adds

Everything below is additive. With the DJ switched off, playback is the upstream player, untouched.

- **liveRave, the DJ engine.** Turn the DJ on and press play: liveRave analyses each track itself (tempo, phrase structure, key, energy contour, vocals), chooses the order inside _your_ playlist, and performs the joins — beatmatched, phrase-aligned blends with EQ and bass swaps, loops, jog moves (nudges, brakes, vinyl stops, spinbacks), scratches (baby, chirp, transformer, flare) and effects (reverb, delay, spiral, flanger, phaser, saturation, gating, slip rolls). Each join is a recipe chosen for that pair of songs from the measurements, never a timed crossfade.
- **DJ personalities and sliders.** Seven personalities — Club, Battle, House, Open Format, Experimental, Radio — plus a personality-free autonomous mode, bend how the engine decides; eight sliders (intensity, creativity, scratching, effects, transition complexity, genre flexibility, energy progression, track-selection freedom) bend them further. At the default settings the engine behaves exactly as the un-personalised build.
- **The DJ stage.** A performance surface modelled on the real DDJ-REV7's layout: two decks, jog wheels that turn at a truthful 33 rpm, channel strips, crossfader, hot-cue pads and a live activity strip that narrates what the DJ just did and why. Its manual controls are alive alongside the autonomous DJ; a light Simple view sits on top of the same decks for smaller screens.
- **Parties.** Host a session and guests join by QR code to request songs — from the whole catalogue, not just the night's playlist — and react live. The decks stay the host's.
- **A personal Home and For You.** Home is assembled only from your own listening — no global charts. Daily Mixes are generated on your device from your taste profile, and **Playlist Genre** — your own labels for your playlists, stored locally — is respected by the DJ's choices, the feed and the library alike.
- **Player comforts.** Volume boost up to 500% behind a limiter, playback that keeps going when the screen turns off, and an updater that checks every 20 minutes and tells you once, quietly, when a restart will apply a new version.

## Preview

_No screenshots are available. The app has changed a great deal and is still being worked on: the redesign is not finished, and not close to finished, to the state it is meant to reach — so screenshots are not expected anytime soon._

---

## Architecture

The renderer follows [Feature-Sliced Design](https://feature-sliced.design): imports only point down the layers (`app` → `widgets` → `features` → `entities` → `shared`). The fork's additions live mainly in `src/features/mixer/` (the two-deck engine, the DJ brain, the stage) and `electron/liverave/` (the party server).

```
liner/desktop/
├── electron/
│   ├── main.ts              # Main process: windows, IPC, updates, deep links
│   ├── preload.ts           # Context bridge between the renderer and the main process
│   ├── local-tracks/        # Imported audio files and the liner-local:// protocol
│   ├── youtube/             # Helpers for the YouTube playback fallback
│   ├── overlay.ts           # Floating overlay player window
│   ├── discord.ts           # Discord Rich Presence
│   ├── crypto.ts            # In-memory WebAssembly request signer
│   └── signer.ts            # Embedded WebAssembly binary
├── native/                  # Windows snap preview add-on
├── src/
│   ├── app/                 # App shell, routes, providers, global styles
│   ├── widgets/             # Screen blocks: sidebar, header, player bar, fullscreen player, modals
│   ├── features/            # player, lyrics, library, search, collection, settings, overlay, …
│   ├── entities/            # track, playlist, artist, user
│   ├── shared/              # API client, storage, UI kit, contracts, utilities
│   ├── languages/           # Translations for 11 languages
│   └── main.tsx             # Vite entry point
├── docs/                    # Design, storage, privacy, translations, FAQ
├── package.json
└── vite.config.ts
```

---

## Getting Started

### Prerequisites

- **Node.js** `v22+` and **pnpm** `v10+`
- Windows 10/11, macOS or Linux

---

### Setup

```bash
git clone https://github.com/Dream-byte-lab/desktop.git
cd desktop
pnpm install
```

---

### Running in Development

```bash
# Electron app with Vite hot reload
pnpm dev
```

---

## Testing

```bash
# Tests only
pnpm test

# Everything CI runs on a pull request: lint, format check, types, build, tests
pnpm check
```

---

## Building

```bash
# Linux (AppImage & .deb)
pnpm electron:build:linux

# Windows (.exe installer)
pnpm electron:build:win

# macOS (.dmg & .zip, for both Intel and Apple Silicon)
pnpm electron:build:mac
```

The macOS build produces `x64` (Intel) and `arm64` (Apple Silicon) packages. To build only one, add `--arm64` or `--x64`. Packages are placed in the `release/` directory.

Release installers for this fork are currently built for Windows (ARM64 + x64) and Linux (AppImage) and published to a private channel for the author's own devices. Linerave remains compatible with macOS at the current version — the source still builds and runs on a Mac (see the macOS build command above), for anyone who wants to try it — but no macOS build is published for the current version. macOS releases are not a priority at the moment; the owner may consider them later, including if there is public demand, but for now they remain off the table.

---

## Docs

- [Design guidelines](./docs/DESIGN.md): tokens, glass surfaces, motion and building blocks
- [Storage](./docs/STORAGE.md): where data lives on your device and what "Clear cache" removes
- [Privacy](./docs/PRIVACY.md): everything the app sends off your device
- [Translations](./docs/I18N.md): adding strings, plurals and languages
- [FAQ](./docs/FAQ.md): answers to the most common problems

---

## Security

Linerave is maintained independently of upstream Liner, including for security. This fork does not rely on upstream for security updates and does not receive them: upstream's over-the-air bundle channel is disabled in Linerave, and the app updates only from this fork's own release channel — built from this repository and published to the fork's own private releases repository.

Upstream changes are never taken automatically. They are reviewed, folded in deliberately, and verified against the fork's full test battery before they ship, and anything touching dependencies or security-sensitive code is held for individual review. The fork runs its own security audits on its own schedule, and security fixes ship in this fork's own releases, on the fork's cadence, without waiting for an upstream release.

Vulnerabilities in Linerave are reported to this fork, not to upstream — see [SECURITY.md](./SECURITY.md).


---

## Contributing

This is a personal fork, maintained for its author's own use. Bug reports and discussion are welcome here, in this repo's Issues and Discussions — reports about Linerave belong with Linerave, not upstream. Security reports never go in a public issue: use this fork's private advisory route (see [SECURITY.md](./SECURITY.md)). Code contributions are not solicited; pull requests are read, but may be declined with thanks. The upstream project is [tryliner/desktop](https://github.com/tryliner/desktop). The [license](./LICENSE) limits what a fork is allowed to do, and this fork stays inside it: personal use and local builds, no commercial distribution, no public competing fork.

---

## Special Thanks

- [`@braccato/core`](https://github.com/better-lyrics/braccato) & `@braccato/parsers` — Synced lyrics components and format parsers.
- [Kawarp](https://github.com/better-lyrics/kawarp) — WebGL background shader the fullscreen background is based on.
- [Solar Icons](https://solar-icons.com) & [MingCute Icons](https://www.mingcute.com) — Icon collections.

---

## License

Linerave is distributed under the **Liner Source-Available & Non-Commercial Contribution License**.

- **Allowed**: Personal non-commercial usage, local builds, and upstream contributions.
- **Prohibited**: Commercial distribution, public competing forks, or extracting core algorithms for third-party products.

See [LICENSE](./LICENSE) for details.
