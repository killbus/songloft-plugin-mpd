const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function compile(file, extra = '', imports = {}) {
  const result = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8') + extra, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true
  });
  if (result.diagnostics.length) throw new Error('Transpile failed: ' + file);
  const exports = {};
  new Function('exports', 'require', result.outputText)(exports, (name) => {
    if (!Object.hasOwn(imports, name)) throw new Error('Unexpected import: ' + name);
    return imports[name];
  });
  return exports;
}
async function main() {
  const dir = process.argv[2];
  if (!dir || !path.isAbsolute(dir)) throw new Error('Absolute runtime directory required');
  const fifo = compile('src/services/mpd/fifo.ts');
  const core = compile('src/services/mpd-core.ts', '\nexport { createDefaultMpdConfig };', { './mpd/fifo': fifo });
  const values = new Map();
  const host = {
    storage: { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); } },
    command: {
      exec: (program, args = [], options = {}) => new Promise(resolve => {
        execFile(program, args, { timeout: options.timeout || 10000, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
      }),
      // No managed plugin binary directory in this system-MPD fixture.
      exists: async () => false, listBin: async () => []
    },
    log: { warn() {}, error() {}, info() {} }
  };
  await core.saveAudioPreferences(host, { outputType: 'fifo', fifoPath: path.join(dir, 'audio.fifo'), fifoFormat: '44100:16:2' });
  const runtime = { rootDir: dir, playlistDir: dir };
  for (const [key, file] of Object.entries({ configPath: 'mpd.conf', logPath: 'mpd.log', pidPath: 'mpd.pid', statePath: 'mpd.state', stickerPath: 'mpd.sticker.sql' })) runtime[key] = path.join(dir, file);
  const config = await core.createDefaultMpdConfig(host, runtime);
  fs.writeFileSync(runtime.configPath, config);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
