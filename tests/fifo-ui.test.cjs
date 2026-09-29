const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

// Runs the real settings/startup code with a small DOM and HTTP stub. No MPD,
// browser, Linux FIFO or Snapcast process is started by this smoke test.
const root = path.resolve(__dirname, "..");
const html = readFileSync(path.join(root, "static/index.html"), "utf8");
const app = readFileSync(path.join(root, "static/js/app.js"), "utf8");
const defaults = {
  outputType: "auto", xdgRuntimeDir: "", pulseServer: "", pipewireRemote: "", alsaDevice: "",
  fifoPath: "/run/snapcast/songloft.fifo", fifoFormat: "44100:16:2"
};
const savedFifo = { ...defaults, outputType: "fifo", fifoPath: "/run/snapcast/saved.fifo", fifoFormat: "48000:24:2" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

async function createUI(initialPreferences = savedFifo) {
  class Element {
    constructor(id = "") {
      this.id = id;
      this.value = "";
      this.textContent = "";
      this.innerHTML = "";
      this.className = "";
      this.hidden = false;
      this.open = false;
      this.style = {};
      this.listeners = {};
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle: (name, on) => on ? classes.add(name) : classes.delete(name)
      };
    }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    dispatch(type) {
      for (const callback of this.listeners[type] || []) {
        callback({ target: this, preventDefault() {}, stopPropagation() {} });
      }
    }
    contains(element) { return this.id === "audioPreferencePanel" && element?.id.startsWith("audio"); }
    setAttribute() {}
  }
  const elements = new Map();
  for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const id = match[1];
    if (!id.startsWith("audio") && !/^(save|reset)AudioPreferencesInlineButton$/.test(id)) continue;
    assert.ok(!elements.has(id), "duplicate DOM id: " + id);
    const element = new Element(id);
    element.value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || "";
    element.hidden = /\bhidden\b/.test(match[0]);
    elements.set(id, element);
  }
  const scene = new Element();
  const document = {
    hidden: true, activeElement: null, body: new Element(), documentElement: { scrollTop: 0 },
    getElementById: (id) => elements.get(id) || null,
    querySelector: (selector) => selector === ".audio-scene-card" ? scene : null,
    querySelectorAll: () => [], addEventListener() {}
  };
  const storage = new Map();
  const window = {
    document, location: { search: "", port: "58091", origin: "http://127.0.0.1" },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {}, scrollTo() {}
  };
  const server = { preferences: { ...initialPreferences }, posts: [], runtimeReads: 0, reject: "" };
  const runtime = () => ({
    serviceStatus: "running", mode: "managed", managedByPlugin: true,
    audioPreferences: { ...server.preferences }, audioGuidance: {}, notes: []
  });
  const player = { playbackStatus: "stopped", outputMode: "mpd", serviceStatus: "running", progress: {} };
  const unexpected = [];
  async function fetch(url, options = {}) {
    let data;
    let message = "ok";
    let status = 200;
    if (url === "./api/mpd/audio/preferences") {
      assert.equal(options.method, "POST");
      const body = JSON.parse(options.body);
      server.posts.push(body);
      const invalid = body.outputType === "fifo" && (!body.fifoPath || !body.fifoFormat || body.fifoFormat.trim() !== body.fifoFormat);
      if (server.reject || invalid) {
        status = 400;
        message = server.reject || "FIFO 参数无效";
      } else {
        const { restart, ...preferences } = body;
        server.preferences = preferences;
        data = { preferences, runtime: runtime(), player };
      }
    } else if (url === "./api/mpd/status") {
      server.runtimeReads += 1;
      data = runtime();
    } else if (url === "./api/mpd/binaries") {
      data = { platform: {}, managedDownload: {} };
    } else if (url === "./api/mpd/autostart") {
      data = { enabled: false };
    } else if (url === "./api/player/state") {
      data = player;
    } else if (url === "./api/ui/bootstrap") {
      data = { mpd: {}, ui: {} };
    } else if (url === "./api/library/songs") {
      data = { songs: [] };
    } else if (url === "./api/library/home") {
      data = { summary: {} };
    } else if (url === "./api/queue") {
      data = { items: [], total: 0 };
    } else {
      unexpected.push(url);
      throw new Error("Unexpected API: " + url);
    }
    return { ok: status === 200, status, text: async () => JSON.stringify({ code: status === 200 ? 0 : 1, message, data }) };
  }
  const boot = "  void start().catch(function (error) {";
  assert.equal(app.split(boot).length, 2, "expected one app startup hook");
  const instrumented = app.replace(boot,
    "  window.__uiTest = { state: state, start: start, poll: refreshSettingsState };\n  void Promise.resolve().catch(function (error) {");
  vm.runInNewContext(instrumented, {
    window, document, HTMLElement: Element, navigator: { userAgent: "UI smoke" },
    console, fetch, AbortController, setTimeout, clearTimeout
  }, { filename: "static/js/app.js" });
  const ui = window.__uiTest;
  await ui.start();
  // Mimic entering settings after boot, then use the same poll as the app timer.
  ui.state.currentView = "settings";
  await ui.poll(true);
  assert.deepEqual(unexpected, [], "startup and polling used only stubbed APIs");
  assert.equal(ui.state.audioPreferencesDirty, false, "startup preset must not block saved preferences");
  const element = (id) => {
    assert.ok(elements.has(id), "missing real HTML element: " + id);
    return elements.get(id);
  };
  return {
    ...ui, element, server, document,
    edit(id, value, event = "input") { element(id).value = value; element(id).dispatch(event); },
    async click(id) { element(id).dispatch("click"); await settle(); }
  };
}

test("FIFO saved preferences render after startup and retain all output choices", async () => {
  const ui = await createUI();
  assert.equal(ui.element("audioOutputTypeSelect").value, "fifo");
  assert.equal(ui.element("audioFifoPathInput").value, savedFifo.fifoPath);
  assert.equal(ui.element("audioFifoFormatInput").value, savedFifo.fifoFormat);
  assert.equal(ui.element("audioFifoSection").hidden, false);
  assert.equal(ui.element("audioDesktopSessionSection").hidden, true);
  assert.equal(ui.element("audioPhysicalOutputSection").hidden, true);
  assert.equal(ui.element("audioBluetoothGuidance").hidden, true);
  assert.equal(ui.element("audioScenarioTitle").textContent, "FIFO / Snapcast");
  const select = html.match(/<select id="audioOutputTypeSelect"[\s\S]*?<\/select>/)[0];
  for (const output of ["auto", "pulse", "alsa", "pipewire", "null", "fifo"]) {
    assert.ok(select.includes('value="' + output + '"'), "missing output: " + output);
  }
  const legacy = await createUI({ outputType: "alsa" });
  assert.equal(legacy.element("audioOutputTypeSelect").value, "alsa");
  assert.equal(legacy.element("audioFifoPathInput").value, defaults.fifoPath);
  assert.equal(legacy.element("audioFifoFormatInput").value, defaults.fifoFormat);
});

test("FIFO input changes stay dirty across settings polls and save/reload exactly", async () => {
  const ui = await createUI();
  ui.edit("audioFifoPathInput", "/run/snapcast/edited pipe.fifo");
  assert.equal(ui.state.audioPreferencesDirty, true);
  ui.edit("audioFifoPathInput", savedFifo.fifoPath);
  assert.equal(ui.state.audioPreferencesDirty, false);
  ui.edit("audioFifoFormatInput", "96000:32:2", "change");
  assert.equal(ui.state.audioPreferencesDirty, true, "format participates in dirty serialization");
  ui.edit("audioFifoPathInput", "/run/snapcast/edited pipe.fifo");
  const reads = ui.server.runtimeReads;
  await ui.poll(false);
  assert.ok(ui.server.runtimeReads > reads);
  assert.equal(ui.element("audioFifoPathInput").value, "/run/snapcast/edited pipe.fifo");
  assert.equal(ui.element("audioFifoFormatInput").value, "96000:32:2");
  assert.equal(ui.state.audioPreferencesDirty, true);
  await ui.click("saveAudioPreferencesInlineButton");
  assert.deepEqual(ui.server.posts.at(-1), {
    ...defaults, outputType: "fifo", fifoPath: "/run/snapcast/edited pipe.fifo", fifoFormat: "96000:32:2", restart: true
  });
  assert.equal(ui.state.audioPreferencesDirty, false);
  assert.match(ui.element("audioScenarioNotice").className, /success/);
  const reloaded = await createUI(ui.server.preferences);
  assert.equal(reloaded.element("audioFifoPathInput").value, "/run/snapcast/edited pipe.fifo");
  assert.equal(reloaded.element("audioFifoFormatInput").value, "96000:32:2");
});

test("FIFO focus/blur protects even a clean form from polling", async () => {
  const ui = await createUI();
  for (const id of ["audioFifoPathInput", "audioFifoFormatInput"]) {
    ui.document.activeElement = ui.element(id);
    ui.element(id).dispatch("focus");
    assert.equal(ui.state.audioPreferencesEditing, true);
    ui.server.preferences = { ...savedFifo, fifoPath: "/run/snapcast/external.fifo", fifoFormat: "88200:16:1" };
    await ui.poll(false);
    assert.equal(ui.element(id).value, id.includes("Path") ? savedFifo.fifoPath : savedFifo.fifoFormat);
    ui.document.activeElement = null;
    ui.element(id).dispatch("blur");
    await settle();
    assert.equal(ui.state.audioPreferencesEditing, false);
    ui.server.preferences = { ...savedFifo };
    await ui.poll(false);
  }
});

test("empty/invalid FIFO values and server errors survive rejection and polling", async () => {
  const ui = await createUI();
  for (const [fifoPath, fifoFormat] of [["", ""], [savedFifo.fifoPath, " 44100:16:2 "]]) {
    ui.edit("audioFifoPathInput", fifoPath);
    ui.edit("audioFifoFormatInput", fifoFormat);
    await ui.click("saveAudioPreferencesInlineButton");
    assert.equal(ui.server.posts.at(-1).fifoPath, fifoPath);
    assert.equal(ui.server.posts.at(-1).fifoFormat, fifoFormat);
    assert.equal(ui.state.audioPreferencesDirty, true);
    await ui.poll(false);
    assert.equal(ui.element("audioFifoPathInput").value, fifoPath);
    assert.equal(ui.element("audioFifoFormatInput").value, fifoFormat);
    assert.match(ui.element("audioScenarioNotice").className, /error/);
  }
  ui.server.reject = '<img src=x onerror="bad()"> MPD FIFO unavailable';
  ui.edit("audioFifoFormatInput", "44100:16:2");
  await ui.click("saveAudioPreferencesInlineButton");
  assert.ok(ui.element("audioScenarioNotice").textContent.includes(ui.server.reject));
  assert.equal(ui.element("audioScenarioNotice").innerHTML, "");
  assert.equal(ui.element("audioOutputTypeSelect").value, "fifo");
});

test("presets preserve FIFO fields; reset sends auto and exact FIFO defaults", async () => {
  const ui = await createUI();
  for (const [button, output] of [["audioScenarioWiredButton", "alsa"], ["audioScenarioBluetoothButton", "pulse"]]) {
    await ui.click(button);
    assert.equal(ui.element("audioOutputTypeSelect").value, output);
    assert.equal(ui.element("audioFifoSection").hidden, true);
    assert.equal(ui.element("audioDesktopSessionSection").hidden, false);
    assert.equal(ui.element("audioPhysicalOutputSection").hidden, false);
    assert.equal(ui.element("audioFifoPathInput").value, savedFifo.fifoPath);
    assert.equal(ui.element("audioFifoFormatInput").value, savedFifo.fifoFormat);
  }
  ui.edit("audioOutputTypeSelect", "fifo", "change");
  assert.equal(ui.element("audioFifoSection").hidden, false);
  ui.edit("audioFifoPathInput", "");
  await ui.click("resetAudioPreferencesInlineButton");
  assert.deepEqual(ui.server.posts.at(-1), { ...defaults, restart: true });
  assert.equal(ui.state.audioPreferencesDirty, false);
  assert.equal(ui.element("audioOutputTypeSelect").value, "auto");
  assert.equal(ui.element("audioFifoSection").hidden, true);
  assert.equal(ui.element("audioFifoPathInput").value, defaults.fifoPath);
  assert.equal(ui.element("audioFifoFormatInput").value, defaults.fifoFormat);
  await ui.poll(false);
  assert.equal(ui.state.audioPreferencesDirty, false);
});