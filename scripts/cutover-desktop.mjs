import { execFileSync } from "node:child_process";
import { readFile, access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Explicit one-time migration; on failure restore native availability without removing data. */
const [sourceHome, sourceState, keychainService, nativePlist] = process.argv.slice(2);
if (!nativePlist) throw new Error("Usage: node scripts/cutover-desktop.mjs SOURCE_HOME SOURCE_STATE KEYCHAIN_SERVICE NATIVE_PLIST");
const label = execFileSync("/usr/bin/plutil", ["-extract", "Label", "raw", "-o", "-", nativePlist], {encoding:"utf8"}).trim();
const target = `gui/${process.getuid()}/${label}`;
const compose = ["compose", "--env-file", "deploy/local/.env", "-f", "compose.desktop.yaml", "-p", "codex-agent-bridge"];
const token = (await readFile("secrets/bridge-token","utf8")).trim();
const headers = {authorization:`Bearer ${token}`};
await access(nativePlist);
const response = await fetch("http://127.0.0.1:8787/health",{headers,signal:AbortSignal.timeout(5000)});
if(!response.ok) throw new Error("Native health unavailable; refusing automatic cutover");
const health = await response.json();
if(health.active!==0) throw new Error(`Native service has ${health.active} active requests; refusing cutover`);
let stopped = false;
try {
  execFileSync("/bin/launchctl",["disable",target]);
  execFileSync("/bin/launchctl",["bootout",target]);
  stopped=true;
  // Wait for the exact retired listener to close before taking SQLite/WAL copies.
  let closed=false;
  for(let attempt=0;attempt<40;attempt++) {
    try {await fetch("http://127.0.0.1:8787/health",{headers,signal:AbortSignal.timeout(500)});}
    catch {closed=true;break;}
    await delay(250);
  }
  if(!closed) throw new Error("Native listener did not stop");
  execFileSync(process.execPath,["scripts/prepare-desktop.mjs","runtime",sourceHome,sourceState,keychainService],{stdio:"inherit"});
  execFileSync("/usr/local/bin/docker",[...compose,"up","-d","--no-build"],{stdio:"inherit"});
  let ready=false;
  for(let attempt=0;attempt<60;attempt++) {
    try {if((await fetch("http://127.0.0.1:8787/ready",{headers,signal:AbortSignal.timeout(1000)})).ok){ready=true;break;}}catch{/* Startup. */}
    await delay(500);
  }
  if(!ready)throw new Error("Docker service did not become ready");
  process.stdout.write("Docker cutover ready; native service disabled, original data retained for rollback.\n");
} catch(error) {
  if(stopped) {
    try {execFileSync("/usr/local/bin/docker",[...compose,"stop"],{stdio:"inherit"});}catch{/* Preserve original failure. */}
  }
  execFileSync("/bin/launchctl",["enable",target]);
  if(stopped)execFileSync("/bin/launchctl",["bootstrap",`gui/${process.getuid()}`,nativePlist]);
  throw error;
}
