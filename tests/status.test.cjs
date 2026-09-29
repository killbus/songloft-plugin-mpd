const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function load(relativePath, imports, host, globals = {}) {
  const { outputText, diagnostics } = ts.transpileModule(
    readFileSync(path.join(root, relativePath), "utf8"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
      reportDiagnostics: true,
      fileName: relativePath
    }
  );
  assert.equal(diagnostics.length, 0);
  const exports = {};
  new Function("exports", "require", "songloft", "globalThis", outputText)(exports, (name) => {
    assert.ok(Object.hasOwn(imports, name), "Unexpected import: " + name);
    return imports[name];
  }, host, globals);
  return exports;
}

test("status retains saved FIFO preferences after restart rejects unsupported output", async () => {
  const values = new Map();
  const host = {
    storage: {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); }
    },
    log: { warn() {}, error() {}, info() {} }
  };
  const fifo = load("src/services/mpd/fifo.ts", {}, host);
  const core = load("src/services/mpd-core.ts", { "./mpd/fifo": fifo }, host);
  const constants = load("src/services/mpd/constants.ts", {}, host);
  const errors = load("src/services/mpd/errors.ts", { "./constants": constants }, host);
  const globals = {};
  let restartAttempts = 0;
  const unsupported = "mpd --version does not advertise fifo output";
  load("src/main.ts", {
    "./services/library": {},
    "./services/mpd-core": {
      ...core,
      restartManagedMpd: async () => { restartAttempts++; throw new Error(unsupported); },
      getMpdRuntimeStatus: async () => { throw new Error(unsupported); }
    },
    "./services/mpd/auth": {},
    "./services/mpd/errors": errors,
    "./services/mpd/cache": {},
    "./services/mpd/constants": constants
  }, host, globals);

  const preferences = { outputType: "fifo", fifoPath: "/shared/custom.fifo", fifoFormat: "48000:24:2" };
  const save = await globals.onHTTPRequest({
    method: "POST", path: "/api/mpd/audio/preferences",
    body: JSON.stringify({ ...preferences, restart: true })
  });
  assert.equal(save.statusCode, 500);
  assert.equal(restartAttempts, 1);
  assert.equal(values.get("mpd:audio:output-type"), "fifo");

  const status = await globals.onHTTPRequest({ method: "GET", path: "/api/mpd/status" });
  assert.equal(status.statusCode, 200);
  const data = JSON.parse(status.body).data;
  assert.equal(data.serviceStatus, "error");
  assert.match(data.error, /does not advertise fifo/);
  assert.ok(data.notes.some((note) => note.includes(unsupported)));
  assert.ok(data.audioPreferences, "Error status must expose saved preferences to settings");
  assert.equal(data.audioPreferences.outputType, preferences.outputType);
  assert.equal(data.audioPreferences.fifoPath, preferences.fifoPath);
  assert.equal(data.audioPreferences.fifoFormat, preferences.fifoFormat);
  assert.equal(data.audioPreferences.hasOverrides, true);
});
