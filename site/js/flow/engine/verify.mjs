// Release check for the PhantomFlow engine files in this folder: the manifest's file sizes and SHA-256 must match the files, and
// the module, run through this folder's own client, must ride the reference ride to the digests the manifest records (and
// reference.js pins), and no file may sit in the folder that the manifest does not list. Plain Node, no packages. Exit 0 only when everything matches.
//
//   node verify.mjs [FOLDER]        (default: the folder this file is in)
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const folder = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const check = (ok, message) => { console.log(`${ok ? "PASS" : "FAIL"}  ${message}`); if (!ok) failures++; };

const manifestPath = join(folder, "manifest.json");
if (!existsSync(manifestPath)) { console.error(`verify: no manifest.json in ${folder}`); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
check(manifest.schema === 1 && manifest.files?.length > 0, `manifest read: engine ${manifest.engine?.version}, layout ${manifest.flowApiLayout}`);

for (const file of manifest.files) {
  const path = join(folder, file.path);
  if (!existsSync(path)) { check(false, `${file.path}: missing`); continue; }
  const bytes = readFileSync(path);
  const sha = createHash("sha256").update(bytes).digest("hex");
  check(bytes.length === file.bytes && sha === file.sha256, `${file.path}: ${bytes.length} bytes, sha256 ${sha.slice(0, 16)}... ${bytes.length === file.bytes && sha === file.sha256 ? "match" : "MISMATCH"}`);
}
const listed = new Set([...manifest.files.map((f) => f.path), "manifest.json"]);
const extra = readdirSync(folder).filter((name) => !listed.has(name));
check(extra.length === 0, extra.length === 0 ? "no file in the folder is missing from the manifest" : `files not in the manifest: ${extra.join(", ")}`);
const wasm = manifest.files.find((f) => f.path === "phantomflow_engine.wasm");
check(Boolean(wasm) && manifest.engine.version.endsWith(wasm.sha256.slice(0, 12)), "the engine version carries the module's hash");

if (failures === 0) {
  const { loadEngine, API_VERSION } = await import(pathToFileURL(join(folder, "engine.js")));
  const ref = await import(pathToFileURL(join(folder, "reference.js")));
  check(API_VERSION === manifest.flowApiLayout, `client layout version ${API_VERSION} equals the manifest's ${manifest.flowApiLayout}`);
  const engine = await loadEngine(pathToFileURL(join(folder, "phantomflow_engine.mjs")), { locateFile: (name) => join(folder, name) });
  check(true, "module loaded; its layout matches the client");
  for (const profile of ["interactive", "ambient"]) {
    const r = ref.runReference(engine, profile);
    const want = manifest.reference[profile];
    check(r.status === 0 && r.digest === want && ref.EXPECTED[profile] === want,
      `${profile}: reference ride digest ${r.digest} ${r.digest === want ? "equals" : "DIFFERS from"} the manifest's ${want} (${r.ticks} ticks)`);
  }
}
console.log(failures === 0 ? "verify: the engine files match their manifest" : `verify: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
