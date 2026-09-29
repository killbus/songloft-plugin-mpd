# Linux FIFO acceptance

The FIFO integration workflow runs on the feature branch, pull requests and manual dispatch. It builds the plugin and runs real system MPD 0.23.14, Snapserver 0.27.0 and Snapclient 0.27.0 on Ubuntu 24.04. It requires no private services or credentials and never publishes a release.

The config adapter invokes the actual plugin configuration generator with saved FIFO preferences. Generated AAC tones travel over HTTP into MPD, through a precreated 44100:16:2 FIFO and FLAC Snapcast transport, into Snapclient file output. Fresh PCM amplitude and frequency checks cover playback, pause/resume, next track, MPD restart and Snapserver reconnection. The FIFO inode must remain stable. Logs, versions, result.json and the plugin build are uploaded even on failure.

Run locally on Linux with Node 22, Python 3, ffmpeg, mpd, mpc, snapserver and snapclient installed:

```sh
npm ci
python3 tests/integration/fifo-snapcast.py
```

Use a fresh checkout with ports 6600, 1704 and 18080 free. CI uses distribution MPD, not the downloaded managed bundle. This verifies the output transport; it does not certify Docker mount permissions, real speaker audibility, QuickJS host loading, private Emby integration, complete Songloft caching or client-initiated cached Range seeking. Those remain separate acceptance gates.

2026-09-29 evidence: push CI run 36506652915 on `feat/fifo-snapcast` commit 9ece4de passed all steps. result.json recorded first-play 434 Hz, resume 442 Hz, next-track 880 Hz, MPD restart 882 Hz, Snapserver reconnect 880 Hz, with nonzero PCM RMS and `fifoInodePreserved: true`. Earlier runs fixed Snapclient channel inheritance (`44100:16:*`) and portable `mpc pause/play` syntax.
