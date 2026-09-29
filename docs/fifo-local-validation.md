# FIFO local validation — 2026-09-29

Local branch: feat/fifo-snapcast, based on a5ab45c52dcbb69fec415c3850596f0ee950dd14. Changes are uncommitted; no push, release, installation or production deployment.

## Implemented

- Explicit FIFO output with persisted path/PCM format, partial updates, settings UI and reset.
- Validated absolute POSIX path and bounded PCM parameters; FIFO must be advertised by a successful MPD output-plugin check. No implicit output fallback.
- No device discovery for selected FIFO. No foreground MPD producer from status/startup diagnostics when saved or configured output is FIFO.
- Storage read failures cannot replace the selected output or FIFO parameters with defaults. Unsupported FIFO retains useful diagnostics and editable settings.
- Shared-container setup documents a stable pre-created pipe, process permissions and matching Snapserver sampleformat.

## Validation

| Check | Result |
| --- | --- |
| npm test | 23/23 passed; simulated host/config/status/diagnostics and actual settings-script tests |
| npm run validate:source | Passed |
| Official builder 2.16.0 / QuickJS | Passed |
| npm run validate | Built manifest and entry/canonical content hashes passed |
| ZIP inspection | CRC, exact equality with build directory, hashes and FIFO UI inclusion passed |
| git diff --check | Passed |
| TypeScript | Baseline 240 diagnostics; current 239; zero added, 1 removed. Full typecheck is NOT passing |

Builder 2.16.0 is pinned because the baseline installed builder rejected existing manifest permissions. Source validation is separate from built hash validation. On Windows build with node node_modules/@songloft/plugin-builder/dist/cli.js build, avoiding the existing Unix-only prebuild cleanup command.

TypeScript comparison uses identical installed dependencies/options with HEAD versus local sources, matching path/code/message and multiplicity. Focused tests transpile in memory and do not replace typechecking.

## Artifact

- Path: dist/mpd-player.jsplugin.zip
- Size: 204814 bytes
- SHA-256: cedd51600d832aac74171615291996cb4ebfee4b8c04a8f20ee659be33bbfb9c
- Entry hash: 5597c5d58503cb6935c2d4a5e53c4c4edc05be7882eb1346a1a1b13289ff988e
- Canonical content hash: abb8c1bd8b025b783c791a2b85b4fccaf93738e722b6a1a54bd7dc5c15444d83

Local development artifact retaining upstream manifest version 2.1.5 and update metadata; not a published fork release.

## Remaining acceptance

This Windows environment has no usable Linux MPD/Snapserver/Snapclient runtime. Real pipe permissions/lifetime, AAC decoding by deployed MPD, audible synchronized output, pause/resume, next track, full cache/replay, seek-initiated Range, and producer/reader restart recovery remain unverified. MPD v0.24 pipe lifetime was checked in upstream source only; see README.

Related Emby AC6 remains open. Official Web cached seeking did not initiate new Range requests; manual Range success cannot substitute for player seeking.
