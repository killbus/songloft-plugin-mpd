const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

// Compile in memory with the existing dev dependency; no artifacts or new runner.
// The test-only exports exercise private config/detection boundaries without
// widening the production module's API. Each load isolates its runtime caches.
const root = path.resolve(__dirname, "..");
function compile(relativePath, extra = "", imports = {}) {
  const source = readFileSync(path.join(root, relativePath), "utf8") + extra;
  const { outputText, diagnostics } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
    fileName: relativePath
  });
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (name) => name, getCurrentDirectory: () => root, getNewLine: () => "\n"
  }));
  const exports = {};
  new Function("exports", "require", outputText)(exports, (specifier) => {
    assert.ok(Object.hasOwn(imports, specifier), "Unexpected import: " + specifier);
    return imports[specifier];
  });
  return exports;
}
const fifo = compile("src/services/mpd/fifo.ts");
function loadCore() {
  return compile("src/services/mpd-core.ts",
    "\nexport { detectAudioOutput, createDefaultMpdConfig, releaseAudioDevices };\n",
    { "./mpd/fifo": fifo });
}

const version = "Music Player Daemon 0.24.0\nOutput plugins:\n shout null fifo alsa pulse\nEncoder plugins:\n vorbis opus\n";
const runtimeFiles = {
  rootDir: "/tmp/songloft-mpd-test", configPath: "/tmp/songloft-mpd-test/mpd.conf",
  logPath: "/tmp/songloft-mpd-test/mpd.log", pidPath: "/tmp/songloft-mpd-test/mpd.pid",
  statePath: "/tmp/songloft-mpd-test/mpd.state", stickerPath: "/tmp/songloft-mpd-test/mpd.sticker.sql",
  playlistDir: "/tmp/songloft-mpd-test"
};
function makeHost(options = {}) {
  const values = new Map(Object.entries(options.values || {}));
  const writes = [];
  const commands = [];
  const starts = [];
  let versionChecks = 0;
  const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
  const host = {
    storage: {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { writes.push([key, value]); values.set(key, value); }
    },
    command: {
      exec: async (program, args = [], execOptions) => {
        commands.push({ program, args, options: execOptions });
        if (program === "uname") return ok(args[0] === "-s" ? "Linux" : "x86_64");
        if (args[0] === "--version") {
          versionChecks++;
          // Resolution succeeds; the later capability check may fail independently.
          if (options.failedVersion && versionChecks > 1) return { ...ok(version), exitCode: 1 };
          return ok(options.version ?? version);
        }
        if (program.endsWith("mpc") && args.includes("status")) {
          return ok("[paused] #1/1 0:00/1:00 (0%)\nvolume: 100% repeat: off random: off single: off consume: off");
        }
        if (program.endsWith("mpc")) return ok();
        if (args[0] === "-lc") {
          const script = args[1];
          if (script.includes("ldd --version")) return ok("glibc");
          if (script.includes("mktemp -d")) return ok(runtimeFiles.rootDir);
          if (script.includes("cat > ") || script.startsWith("if [ -e ") || script === "exit 0") return ok();
          if (script.includes("tail -n")) return ok(options.logText || "");
          if (script.includes("then cat ")) return ok(options.configContent || "");
        }
        return { exitCode: 1, stdout: "", stderr: "Not available in headless test host" };
      },
      listBin: async () => [],
      exists: async () => false,
      isRunning: async () => false,
      start: async (...args) => { starts.push(args); return { pid: 42 }; }
    },
    songs: { list: async () => [], search: async () => [], getById: async () => null },
    log: { warn() {}, error() {}, info() {} },
    fs: new Proxy({}, { get: () => () => assert.fail("FIFO must not use sandbox fs") })
  };
  return { host, values, writes, commands, starts };
}
const fifoValues = { "mpd:audio:output-type": "fifo" };
function assertNoAudioDeviceProbes(commands) {
  const text = JSON.stringify(commands);
  assert.doesNotMatch(text, /pactl|aplay|\/dev\/snd|\/proc\/asound|XDG_RUNTIME_DIR|PULSE_SERVER|PIPEWIRE_REMOTE|fuser/);
}

test("FIFO validates absolute paths and bounded PCM while rejecting config injection", () => {
  for (const fifoPath of ["/run/snapcast/songloft.fifo", "/shared/audio pipe.fifo", "/音频/pcm.fifo"]) {
    for (const format of ["8000:16:1", "44100:16:2", "48000:24:2", "384000:32:2"]) {
      assert.doesNotThrow(() => fifo.validateFifoPreferences(fifoPath, format));
    }
  }
  for (const fifoPath of ["", "/", "relative.fifo", "C:/pipe", "//pipe", "/run/", "/run/../pipe", "/run/./pipe",
    "/run/pipe\n", "/run/pipe\r", "/run/pipe\0", "/run/pipe\t", "/run/pipe\u007f", "/run/pipe\u2028",
    '/run/pipe"\naudio_output { type "alsa" }', "/run/pipe\\x", null, 1]) {
    assert.throws(() => fifo.validateFifoPreferences(fifoPath, "44100:16:2"), /FIFO/);
  }
  for (const format of ["", "7999:16:2", "384001:16:2", "44100:8:2", "44100:64:2", "44100:16:0",
    "44100:16:3", "44100:16:*", "44100.0:16:2", " 44100:16:2", "44100:16:2\n", "44100:16:2\r",
    '44100:16:2"\nmixer_type "hardware', null, 44100]) {
    assert.throws(() => fifo.validateFifoPreferences("/run/audio.fifo", format), /FIFO/);
  }
});

test("FIFO support must be a token in the MPD output plugin section", () => {
  assert.equal(fifo.hasFifoOutput(version), true);
  assert.equal(fifo.hasFifoOutput("Output plugins: ALSA FIFO NULL\r\nEncoder plugins: opus"), true);
  assert.equal(fifo.hasFifoOutput("Output plugins:\nalsa\nfifo\nEncoder plugins:\nopus"), true);
  for (const unsupported of ["fifo", "Output plugins:\n fifo_disabled null\n", "Input plugins:\n fifo\nOutput plugins:\n null\n",
    "Output plugins:\n alsa null\nEncoder plugins:\n fifo\n"]) {
    assert.equal(fifo.hasFifoOutput(unsupported), false);
  }
});

test("preferences supply FIFO defaults and preserve fields across partial updates and reloads", async () => {
  const core = loadCore();
  const { host, values } = makeHost();
  const defaults = await core.readAudioPreferences(host);
  assert.equal(defaults.outputType, "auto");
  assert.equal(defaults.fifoPath, "/run/snapcast/songloft.fifo");
  assert.equal(defaults.fifoFormat, "44100:16:2");
  assert.equal(defaults.hasOverrides, false);
  await core.saveAudioPreferences(host, { outputType: "fifo", fifoPath: "/shared/music.fifo", pulseServer: "unix:/old-session" });
  const updated = await core.saveAudioPreferences(host, { fifoFormat: "48000:24:2" });
  assert.equal(updated.outputType, "fifo");
  assert.equal(updated.fifoPath, "/shared/music.fifo");
  assert.equal(updated.pulseServer, "unix:/old-session");
  assert.equal(updated.hasOverrides, true);
  assert.equal(values.get("mpd:audio:fifo-format"), "48000:24:2");
  assert.deepEqual(await loadCore().readAudioPreferences(host), updated);
  assert.deepEqual(await core.saveAudioPreferences(host, {}), updated);
});

test("invalid selected FIFO is rejected before any preference write; dormant FIFO values do not block other modes", async () => {
  const core = loadCore();
  const { host, writes } = makeHost();
  await core.saveAudioPreferences(host, { outputType: "alsa", alsaDevice: "hw:1,0", fifoPath: "invalid", fifoFormat: "bad" });
  writes.length = 0;
  await assert.rejects(core.saveAudioPreferences(host, { outputType: "fifo" }), /FIFO/);
  assert.equal(writes.length, 0);
  assert.equal((await core.readAudioPreferences(host)).outputType, "alsa");
  await core.saveAudioPreferences(host, { outputType: "fifo", fifoPath: fifo.DEFAULT_FIFO_PATH, fifoFormat: fifo.DEFAULT_FIFO_FORMAT });
  writes.length = 0;
  await assert.rejects(core.saveAudioPreferences(host, { fifoFormat: "44100:16:2\n" }), /FIFO/);
  await assert.rejects(core.saveAudioPreferences(host, { fifoPath: "" }), /FIFO/);
  assert.equal(writes.length, 0);
  assert.equal((await core.readAudioPreferences(host)).fifoFormat, fifo.DEFAULT_FIFO_FORMAT);
});

test("saved FIFO generates the sole software-mixed PCM output without host audio probes", async () => {
  const core = loadCore();
  const { host, values, commands } = makeHost();
  await core.saveAudioPreferences(host, { outputType: "fifo", fifoPath: "/shared/music pipe.fifo", fifoFormat: "48000:24:2",
    alsaDevice: "hw:0,0", pulseServer: "unix:/ignored", xdgRuntimeDir: "/run/user/1000", pipewireRemote: "ignored" });
  const config = await core.createDefaultMpdConfig(host, runtimeFiles);
  assert.match(config, /audio_output \{\n  type "fifo"\n  name "Songloft FIFO Output"\n  path "\/shared\/music pipe.fifo"\n  format "48000:24:2"\n  mixer_type "software"\n\}/);
  assert.equal((config.match(/audio_output \{/g) || []).length, 1);
  assert.doesNotMatch(config, /type "(?:alsa|pulse|pipewire|null)"/);
  const detection = await core.detectAudioOutput(host);
  assert.equal(detection.selected.type, "fifo");
  assert.deepEqual(detection.env, {});
  assert.deepEqual(detection.guidance.alsaDeviceOptions, []);
  assert.equal(JSON.parse(values.get("player:audio-output-snapshot")).selectedType, "fifo");
  assertNoAudioDeviceProbes(commands);
  assert.doesNotMatch(JSON.stringify(commands), /mkfifo|mkdir|rm -/);
});

test("unsupported FIFO and failed capability checks reject startup without writing config or falling back", async () => {
  for (const options of [{ version: "Output plugins:\n alsa null\n" }, { version: "Output plugins:\n null\nInput plugins:\n fifo\n" },
    { version: "" }, { failedVersion: true }]) {
    const core = loadCore();
    const { host, commands, starts, values } = makeHost({ ...options, values: fifoValues });
    await assert.rejects(core.startManagedMpd(host), /fifo 输出支持/);
    assert.equal(starts.length, 0);
    assert.equal(values.has("player:audio-output-snapshot"), false);
    assert.equal(commands.some(({ args }) => args.some((arg) => arg.includes("cat > "))), false);
    assertNoAudioDeviceProbes(commands);
  }
});

test("persisted invalid FIFO cannot reach config generation", async () => {
  const core = loadCore();
  const { host } = makeHost({ values: { ...fifoValues, "mpd:audio:fifo-path": '/run/pipe"\n}\n' } });
  await assert.rejects(core.createDefaultMpdConfig(host, runtimeFiles), /FIFO/);
});

test("managed FIFO startup writes only its MPD runtime config and preserves empty audio environment", async () => {
  const core = loadCore();
  const { host, commands, starts } = makeHost({ values: fifoValues });
  assert.deepEqual(await core.startManagedMpd(host), { pid: 42, reused: false });
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0][3].env, {});
  const write = commands.find(({ args }) => args.some((arg) => arg.includes("cat > ")));
  assert.ok(write);
  assert.match(write.args[1], /path "\/run\/snapcast\/songloft.fifo"/);
  assert.match(write.args[1], /format "44100:16:2"/);
  const scripts = commands.flatMap(({ args }) => args).join("\n");
  assert.doesNotMatch(scripts, /mkfifo|rm -|mkdir[^\n]*snapcast/);
  assertNoAudioDeviceProbes(commands);
});

test("FIFO skips sound-card cleanup for selected or previously running FIFO", async () => {
  for (const values of [fifoValues, { "mpd:audio:output-type": "alsa", "player:audio-output-snapshot": '{"selectedType":"fifo"}' }]) {
    const core = loadCore();
    const { host, commands } = makeHost({ values });
    await core.releaseAudioDevices(host);
    assert.deepEqual(commands, []);
  }
});

test("FIFO start failure is returned without trying another output", async () => {
  const core = loadCore();
  const { host, commands } = makeHost({ values: fifoValues });
  let attempts = 0;
  host.command.start = async () => { attempts++; throw new Error("FIFO directory unavailable"); };
  await assert.rejects(core.startManagedMpd(host), /FIFO directory unavailable/);
  assert.equal(attempts, 1);
  const configWrites = commands.filter(({ args }) => args.some((arg) => arg.includes("cat > ")));
  assert.equal(configWrites.length, 1);
  assert.doesNotMatch(configWrites[0].args[1], /type "(?:alsa|pulse|pipewire|null)"/);
});

test("automatic and explicit null outputs ignore dormant invalid FIFO values", async () => {
  for (const outputType of ["auto", "null"]) {
    const core = loadCore();
    const { host } = makeHost({ values: { "mpd:audio:output-type": outputType,
      "mpd:audio:fifo-path": "invalid", "mpd:audio:fifo-format": "bad" } });
    const detection = await core.detectAudioOutput(host);
    assert.equal(detection.selected.type, "null");
    assert.equal(detection.candidates.some(({ type }) => type === "fifo"), false);
  }
});

test("paused FIFO runtime status does not launch another MPD against the same pipe", async () => {
  const core = loadCore();
  const { host, commands } = makeHost({ values: { ...fifoValues, "player:runtime-files-snapshot": JSON.stringify(runtimeFiles) } });
  assert.equal((await core.getPlayerState(host)).playbackStatus, "paused");
  const runtime = await core.getMpdRuntimeStatus(host);
  assert.equal(runtime.audioPreferences.fifoFormat, "44100:16:2");
  assert.equal(runtime.audioGuidance.recommendedOutputType, "fifo");
  assert.doesNotMatch(JSON.stringify(commands), /__PROBE_META__|--no-daemon/);
  assertNoAudioDeviceProbes(commands);
});

test("startup diagnostics skip both foreground probes for saved or configured FIFO", async () => {
  for (const [saved, configured] of [["fifo", "null"], ["auto", "fifo"], ["null", "fifo"]]) {
    const core = loadCore();
    const { host, commands } = makeHost({ values: {
      "mpd:audio:output-type": saved,
      "player:audio-output-snapshot": JSON.stringify({ selectedType: configured }),
      "player:runtime-files-snapshot": JSON.stringify(runtimeFiles)
    } });
    const diagnostics = await core.getMpdStartupDiagnostics(host);
    assert.equal(diagnostics.runtime.audioPreferences.outputType, saved);
    assert.equal(diagnostics.runtimeError, null);
    assert.equal(diagnostics.probes.mpdLaunch, null);
    assert.equal(diagnostics.probes.mpdStderrLaunch, null);
    assert.match(diagnostics.startupNotes.join("\n"), /FIFO/);
    assert.doesNotMatch(JSON.stringify(commands), /__PROBE_META__|--no-daemon|cat > /);
  }
});

test("runtime status respects configured FIFO after saving auto without restarting", async () => {
  const core = loadCore();
  const { host, commands } = makeHost({ values: {
    ...fifoValues,
    "player:audio-output-snapshot": '{"selectedType":"fifo","selectedName":"Songloft FIFO Output"}',
    "player:runtime-files-snapshot": JSON.stringify(runtimeFiles)
  } });
  await core.saveAudioPreferences(host, { outputType: "auto" });
  const runtime = await core.getMpdRuntimeStatus(host);
  assert.equal(runtime.audioPreferences.outputType, "auto");
  assert.match(runtime.notes.join("\n"), /Songloft FIFO Output/);
  assert.doesNotMatch(JSON.stringify(commands), /__PROBE_META__|--no-daemon|cat > /);
});

test("storage failures cannot replace FIFO settings with defaults or auto and reach config/start", async () => {
  for (const failedKey of ["mpd:audio:fifo-path", "mpd:audio:fifo-format", "mpd:audio:output-type"]) {
    const core = loadCore();
    const { host, commands, writes, starts, values } = makeHost({ values: {
      ...fifoValues,
      "mpd:audio:fifo-path": "/shared/custom.fifo",
      "mpd:audio:fifo-format": "48000:24:2"
    } });
    const get = host.storage.get;
    host.storage.get = async (key) => {
      if (key === failedKey) throw new Error("storage unavailable: " + key);
      return get(key);
    };
    await assert.rejects(core.readAudioPreferences(host), /storage unavailable/);
    await assert.rejects(core.saveAudioPreferences(host, {}), /storage unavailable/);
    assert.equal(writes.length, 0);
    await assert.rejects(core.createDefaultMpdConfig(host, runtimeFiles), /storage unavailable/);
    await assert.rejects(core.startManagedMpd(host), /storage unavailable/);
    assert.equal(starts.length, 0);
    assert.equal(values.has("player:audio-output-snapshot"), false);
    assert.equal(values.get("mpd:audio:output-type"), "fifo");
    assert.equal(values.get("mpd:audio:fifo-path"), "/shared/custom.fifo");
    assert.equal(values.get("mpd:audio:fifo-format"), "48000:24:2");
    assert.doesNotMatch(JSON.stringify(commands), /cat > |--no-daemon/);
    assertNoAudioDeviceProbes(commands);
  }
});

test("unsupported FIFO preserves partial startup diagnostics and exposes the runtime error", async () => {
  const core = loadCore();
  const configContent = 'audio_output {\n type "fifo"\n path "/shared/custom.fifo"\n}\n';
  const { host, commands } = makeHost({
    version: "Output plugins:\n alsa null\n",
    configContent,
    logText: "FIFO output unavailable",
    values: { ...fifoValues, "player:runtime-files-snapshot": JSON.stringify(runtimeFiles) }
  });
  const diagnostics = await core.getMpdStartupDiagnostics(host);
  assert.equal(diagnostics.runtime, null);
  assert.match(diagnostics.runtimeError, /fifo 输出支持/);
  assert.ok(diagnostics.startupNotes.some((note) => note.includes(diagnostics.runtimeError)));
  assert.equal(diagnostics.player.playbackStatus, "paused");
  assert.equal(diagnostics.log.tailText, "FIFO output unavailable");
  assert.equal(diagnostics.binary.mpd.executableAvailable, true);
  assert.equal(diagnostics.config.content, configContent);
  assert.equal(diagnostics.probes.mpcStatus.exitCode, 0);
  assert.equal(diagnostics.probes.mpdLaunch, null);
  assert.equal(diagnostics.probes.mpdStderrLaunch, null);
  assert.doesNotMatch(JSON.stringify(commands), /__PROBE_META__|--no-daemon/);
});

test("startup diagnostics keep storage errors explicit and do not probe unknown output settings", async () => {
  const core = loadCore();
  const { host, commands } = makeHost({ values: { ...fifoValues, "player:runtime-files-snapshot": JSON.stringify(runtimeFiles) } });
  const get = host.storage.get;
  host.storage.get = async (key) => {
    if (key === "mpd:audio:output-type") throw new Error("output storage unavailable");
    return get(key);
  };
  const diagnostics = await core.getMpdStartupDiagnostics(host);
  assert.equal(diagnostics.runtime, null);
  assert.match(diagnostics.runtimeError, /output storage unavailable/);
  assert.equal(diagnostics.binary.mpd.executableAvailable, true);
  assert.equal(diagnostics.probes.mpcStatus.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(commands), /__PROBE_META__|--no-daemon/);
  assertNoAudioDeviceProbes(commands);
});
