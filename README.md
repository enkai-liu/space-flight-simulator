# Space Flight Simulator

A mobile-first 3D space flight simulator inspired by Spaceflight Simulator and
Kerbal Space Program. Three.js + TypeScript, shipped to iOS/Android via
Capacitor, with real-time lobby multiplayer.

- **Physics**: patched-conic orbital mechanics (Kepler orbits + SOI
  transitions), time-warp to ×100,000, atmospheric drag and re-entry heating,
  parachutes, part-based rockets with staging and fuel flow. ~1/10-scale
  11-body solar system (the "Helios" system) for fast, fun orbital play.
- **Builder**: SFS-style 2.5D drag-and-drop vehicle assembly with live TWR/Δv
  readouts, craft saving, and 6-character share codes.
- **Multiplayer**: 2–8 player lobbies in one shared solar system,
  server-authoritative deterministic sim with client prediction, min-rule
  coordinated time-warp ("slowest player wins"), anonymous device accounts,
  5-minute reconnect grace.

## Packages (pnpm workspaces)

| Package | Role |
| --- | --- |
| `@sfs/sim` | Deterministic f64 physics core — zero dependencies, shared by client and server |
| `@sfs/data` | Solar system definition, part catalog, stock craft |
| `@sfs/protocol` | Client↔server message types |
| `@sfs/client` | Vite + Three.js game (browser + Capacitor) |
| `@sfs/server` | Node.js lobby/multiplayer + craft-share server (port 8081) |

## Development

```sh
pnpm install
pnpm dev                        # client dev server on :5173
pnpm --filter @sfs/server dev   # multiplayer server on :8081 (optional for solo play)
pnpm test                       # 67 physics/protocol/lobby unit tests (vitest)
pnpm e2e                        # Playwright browser E2E: builder, launch-to-flight, staging, multiplayer
pnpm typecheck                  # strict TS across all packages
```

The E2E suite starts both servers itself and asserts against `window.__sfs`, a
dev-only deterministic state handle exposed by the flight screen — tests check
physics truth (altitude climbing, stage counts, two vessels in a shared lobby)
rather than pixels. CI runs unit tests, typecheck, and E2E on every push.

Multiplayer locally: open two browser tabs, set a pilot name in each, HOST in
one (the lobby code appears as a toast in flight), JOIN with that code in the
other. Point at a remote server with `?server=host:8081`.

Useful client URL params: `?debug` (fps/orbit readout overlay), `?server=`
(multiplayer server override).

Keyboard (desktop): `A/D` rotate · `W/S` throttle · `Z/X` full/zero throttle ·
`Space` stage · `M` map · `,`/`.` time-warp.

## iOS packaging (Capacitor)

The iOS project lives in `packages/client/ios` (SPM-based, no CocoaPods). To
build it you need Xcode with its first-launch components installed:

```sh
sudo xcodebuild -runFirstLaunch    # one-time Xcode setup if never run
cd packages/client
pnpm build && npx cap sync ios
npx cap open ios                   # build/run from Xcode (simulator or device)
```

Android: install Android Studio, then `pnpm --filter @sfs/client add @capacitor/android && npx cap add android`.

## Persistence note

The server stores accounts and shared crafts in a JSON file
(`packages/server/data/store.json`). Swapping in SQLite (better-sqlite3) is a
contained change inside `packages/server/src/store.ts` when the data outgrows
a single file.
