import { cp, mkdir, readFile, writeFile, chmod, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { resolve, join } from "node:path";
import Database from "better-sqlite3";

/** Copies private runtime data only into ignored deployment directories. Never logs secrets. */
const [mode, sourceHome, sourceState, keychainService] = process.argv.slice(2);
if (!["candidate", "runtime"].includes(mode) || !sourceHome || !sourceState || !keychainService)
  throw new Error("Usage: node scripts/prepare-desktop.mjs candidate|runtime SOURCE_HOME SOURCE_STATE KEYCHAIN_SERVICE. Stop the native service before runtime migration.");
/** Fixed destinations cannot accidentally overwrite the source or another repository. */
const root = resolve("deploy/local", mode);
try { await access(root); throw new Error("Destination already exists; choose an explicit recovery procedure instead of overwriting."); }
catch (error) { if (error.code !== "ENOENT") throw error; }
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(resolve("deploy/local"), 0o700);
await mkdir(join(root, "workspace"), {mode:0o700});
await mkdir(join(root, "codex-home"), {mode:0o700});
await mkdir(join(root, "state/admin"), {recursive:true,mode:0o700});
if (mode === "runtime") {
  // The caller must stop the native writer first; retain the original for rollback.
  await cp(sourceHome, join(root,"codex-home"), {recursive:true});
  await cp(sourceState, join(root,"state"), {recursive:true});
} else {
  for (const file of ["auth.json", "models_cache.json", "models.no-responses-lite.json"])
    await cp(join(sourceHome,file),join(root,"codex-home",file));
  for (const file of ["admin-token", "master.key"])
    await cp(join(sourceState,"admin",file),join(root,"state/admin",file));
  const db = new Database(join(sourceState,"admin/admin.sqlite"),{readonly:true});
  try { await db.backup(join(root,"state/admin/admin.sqlite")); } finally { db.close(); }
}
/** Translate only the isolated Codex-home path, never rewrite desktop configuration. */
const config = (await readFile(join(sourceHome,"config.toml"),"utf8"))
  .split(sourceHome).join("/data/codex")
  .replace(/\[projects\.[^\n]+\]\n(?:[^[]*(?=\[|$))/g, "")
  + '\n[projects."/workspace"]\ntrust_level = "trusted"\n';
await writeFile(join(root,"codex-home/config.toml"),config,{mode:0o600});
await mkdir("secrets",{recursive:true,mode:0o700});
const secret = execFileSync("/usr/bin/security",["find-generic-password","-a",userInfo().username,"-s",keychainService,"-w"],{encoding:"utf8"}).trim();
if (!secret) throw new Error("Empty keychain credential");
try {
  const existing = (await readFile("secrets/bridge-token","utf8")).trim();
  if(existing!==secret) throw new Error("Existing deployment key differs; refusing overwrite.");
} catch(error) { if(error.code!=="ENOENT") throw error; await writeFile("secrets/bridge-token",secret,{mode:0o600,flag:"wx"}); }
await chmod("secrets/bridge-token",0o600);
process.stdout.write(`Prepared ${mode} deployment; no credentials printed.\n`);
