# MPD bundle acceptance (2026-09-29)

Decision: evaluate existing assets and test them before considering a new binary
build pipeline. Keep the official Songloft image unchanged. No production default
URL change, release, or new binary build is part of this candidate evaluation.

## Evidence

- Plugin download URLs still select huaimi123/mympd v1.0.0.
- The deployed MPD reports 0.24.12, output plugins null/alsa/pipewire/pulse,
  no FIFO, and no listed FFmpeg/AAC decoder. FIFO rejection is expected.
- Upstream also publishes v1.0.1; its notes say FFmpeg and soxr enabled, ICU
  disabled. Notes alone do not prove FIFO or runtime compatibility.
- v1.0.1 tag points to d61849813a749637476d22da8aa9c2302b2e39d7.
- x86_64-musl asset ID 460072381, 12067604 bytes; updated 2026-09-22.
- SHA256: 380b220c098e3c34b1f9b92ddff6e546fd52efc095b9b1173f47d106dae6d79f.
- Current public musl scripts specify MPD 0.23.15 and enable FIFO and FFmpeg.
  They cannot establish the provenance of the deployed 0.24.12 artifact.
- Recent upstream Actions runs, including the tag commit's run, failed. A
  successful source-to-release build association has not been established.

Sources: https://github.com/huaimi123/mympd/releases/tag/v1.0.1 and
https://github.com/huaimi123/mympd/blob/main/scripts/build-linux-x86_64-musl.sh

## Acceptance boundary

The independent official-bundle workflow checks the downloaded archive hash,
records the official image digest and binary version output, and executes that
bundle in the unchanged image. The existing plugin configuration generator and
real HTTP AAC / FIFO / Snapserver / Snapclient fixture check first playback,
pause/resume, next track, MPD restart, and Snapserver reconnect using fresh PCM.
Test-side tools run on the CI host; none are installed in the Songloft image.

This is x86_64-musl runtime/configuration acceptance, not a test of the Songloft
UI installer or real Emby service. Image latest is resolved and recorded per run;
a successful result applies to the recorded digest. Other architectures require
separate acceptance. Bundle provenance remains a separate open question even if
playback passes. Do not claim a passing result before examining CI evidence.

## Verified result

CI https://github.com/killbus/songloft-plugin-mpd/actions/runs/36526732420
passed on commit 9f79994. The initial run failed in the test's MPC version probe;
MPC uses `help` to report its client version, not `--version`.

The pinned v1.0.1 x86_64-musl asset contains MPD 0.23.15, reports FIFO output
and FFmpeg AAC decoding, and passed first play, pause/resume, next track, MPD
restart, and Snapserver reconnect with fresh PCM measured at Snapclient. The
precreated FIFO inode was preserved.

Official image repository digest:
`songloft/songloft@sha256:d39a89a38db855bed63a83469dc816d767386c3f5c0db953d8990bb1d08f14fa`.

This proves the existing candidate works for the tested runtime/audio scope; a
new binary build pipeline is not required for that scope. UI bundle installation,
production Emby playback, other platforms, and source-to-asset provenance remain
outside this passing result. Default plugin download URLs remain unchanged.
