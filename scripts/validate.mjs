import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, validateManifest, computeEntryHash, computeCanonicalZipHash } from "@songloft/plugin-builder";

const sourceOnly = process.argv.includes("--source");
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", sourceOnly ? "." : "dist/_build");
try {
  const manifest = readManifest(directory);
  const errors = validateManifest(manifest);
  assert.equal(errors.length, 0, errors.map(error => `${error.field}: ${error.message}`).join("\n"));
  if (!sourceOnly) {
    const entry = fs.readFileSync(path.join(directory, manifest.main));
    assert.equal(manifest.entryHash, computeEntryHash(entry), "Built entry hash mismatch");
    assert.equal(manifest.zipHash, computeCanonicalZipHash(directory), "Built content hash mismatch");
  }
  console.log(sourceOnly ? "Source manifest is valid." : "Built manifest and content hashes are valid.");
} catch (error) {
  console.error(error.message);
  if (!sourceOnly) console.error("Build the plugin first with npm run build.");
  process.exitCode = 1;
}
