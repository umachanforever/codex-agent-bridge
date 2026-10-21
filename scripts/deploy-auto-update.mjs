import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** Repository-owned entry point, also invoked by the host's midnight cron job. */
const script = fileURLToPath(import.meta.url);
/** Deployment paths stay relative to the original checkout, including Compose mounts. */
const root = resolve(dirname(script), "..");
/** Private scheduler state is deliberately excluded from Git and Docker contexts. */
const state = join(root, ".auto-update");

/** Executes structured arguments; diagnostics remain in the caller's private terminal/log. */
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args[0] ?? ""} failed; exit ${result.status ?? "unavailable"}`,
    );
  }
  return result.stdout.replace(/\n$/, "");
}

/** Quotes one literal shell argument for crontab, including cron's special percent character. */
export function cronQuote(value) {
  if (/[\r\n\0]/.test(value))
    throw new Error("Scheduler arguments cannot contain line breaks or NUL.");
  return `'${value.replaceAll("'", "'\\''")}'`.replaceAll("%", "\\%");
}

/** Accepts only a strictly newer stable version, preventing registry rollback/downgrade. */
export function newerVersion(current, latest) {
  if (!/^\d+\.\d+\.\d+$/.test(current) || !/^\d+\.\d+\.\d+$/.test(latest))
    throw new Error("Expected stable versions.");
  const a = current.split(".").map(Number),
    b = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return b[i] > a[i];
  }
  return false;
}

/** Replaces only this checkout's scheduler entry while preserving other cron jobs. */
export function cronEntry(existing, command, marker) {
  return `${existing
    .split("\n")
    .filter((line) => line && !line.endsWith(` # ${marker}`))
    .join("\n")}\n0 0 * * * ${command} # ${marker}\n`;
}

/** Sequences maintenance, idle verification, deployment and rollback without killing active work. */
export async function deployWhenIdle(ops) {
  await ops.maintenance(true);
  try {
    if (!(await ops.idle())) return false;
    try {
      await ops.deploy();
      await ops.verify();
    } catch (error) {
      await ops.rollback();
      await ops.verify();
      throw error;
    }
    return true;
  } finally {
    await ops.maintenance(false);
  }
}

/** Runs a small credential-safe operation inside the existing bridge container. */
function containerNode(id, source) {
  return run("docker", [
    "exec",
    id,
    "node",
    "--input-type=module",
    "-e",
    source,
  ]);
}

/** Reads only the authenticated loopback probe, never exposing the client key. */
function health(id) {
  return JSON.parse(
    containerNode(
      id,
      `
    import { readFileSync } from 'node:fs';
    const token = readFileSync(process.env.CODEX_BRIDGE_TOKEN_FILE, 'utf8').trim();
    const r = await fetch('http://127.0.0.1:8787/health', {headers: {Authorization: 'Bearer '+token}, signal: AbortSignal.timeout(4000)});
    if (!r.ok) throw new Error('health failed');
    console.log(JSON.stringify(await r.json()));
  `,
    ),
  );
}

/** Copies checkout sources to an isolated Git snapshot so updates never overwrite local edits. */
function snapshot(destination) {
  const files = run("git", [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])
    .split("\0")
    .filter(Boolean);
  for (const file of files) {
    const from = join(root, file);
    if (!existsSync(from)) continue;
    const to = join(destination, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  run("git", ["init", "-q"], destination);
  run("git", ["add", "."], destination);
  run(
    "git",
    [
      "-c",
      "user.name=Bridge updater",
      "-c",
      "user.email=updater@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "Deployment source snapshot",
    ],
    destination,
  );
}

/** Builds and checks a candidate using the existing repository upgrade gates. */
function candidate(directory, version, image, buildArgs) {
  snapshot(directory);
  run("npm", ["ci", "--no-audit", "--no-fund"], directory);
  run("npm", ["--prefix", "web", "ci", "--no-audit", "--no-fund"], directory);
  const previous = JSON.parse(readFileSync(join(directory, "package.json")))
    .dependencies["@openai/codex"];
  // Version documentation is part of the existing contract gate, not an upstream behavior claim.
  for (const file of [
    "README.md",
    "docs/zh-CN/README.md",
    "docs/en/client-api.md",
    "docs/zh-CN/client-api.md",
    "docs/en/compatibility.md",
    "docs/zh-CN/compatibility.md",
    "protocol/CONTRACT.md",
  ]) {
    const path = join(directory, file);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replaceAll(previous, version),
    );
  }
  run("npm", ["run", "update:codex", "--", version], directory);
  const args = ["build", "-t", image];
  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    if (value != null) args.push("--build-arg", `${key}=${value}`);
  }
  run("docker", [...args, directory]);
  run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    image,
    "node",
    "--input-type=module",
    "-e",
    `import Database from 'better-sqlite3'; const d = new Database(':memory:'); d.prepare('select 1').get(); d.close();`,
  ]);
  const actual = run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    image,
    "node",
    "node_modules/@openai/codex/bin/codex.js",
    "--version",
  ]);
  if (actual !== `codex-cli ${version}`)
    throw new Error("Candidate version mismatch.");
}

/** Installs a portable macOS/Linux user cron job; plain docker compose remains manual. */
function install(args) {
  if (process.platform === "win32")
    throw new Error(
      "Automatic deployment currently requires a macOS/Linux host with crontab.",
    );
  const marker = `codex-agent-bridge:${Buffer.from(root).toString("hex")}`;
  const logfile = join(state, "update.log");
  if (!existsSync(logfile)) writeFileSync(logfile, "", { mode: 0o600 });
  chmodSync(logfile, 0o600);
  const command = `cd ${cronQuote(root)} && PATH=${cronQuote(`${dirname(process.execPath)}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`)} ${[process.execPath, script, "--scheduled", ...args].map(cronQuote).join(" ")} >> ${cronQuote(logfile)} 2>&1`;
  const existing = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (
    existing.error ||
    (existing.status !== 0 && !/no crontab/i.test(existing.stderr))
  )
    throw new Error("Cannot read existing crontab.");
  const result = spawnSync("crontab", ["-"], {
    input: cronEntry(existing.stdout, command, marker),
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error("Cannot install midnight schedule.");
}

/** Deploys initially or performs one idle-only scheduled upgrade with an exclusive host lock. */
async function main() {
  const args = process.argv.slice(2);
  const scheduled = args[0] === "--scheduled";
  if (scheduled) args.shift();
  if (scheduled && new Date().getHours() !== 0) return;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const lock = join(state, "lock");
  try {
    mkdirSync(lock);
  } catch (error) {
    if (error.code === "EEXIST") return;
    throw error;
  }
  let directory;
  try {
    const compose = (...tail) => run("docker", ["compose", ...args, ...tail]);
    const config = JSON.parse(compose("config", "--format", "json"));
    if (!config.services.bridge || !config.services.gateway)
      throw new Error("Compose must define bridge and gateway.");
    const id = () => {
      const value = compose("ps", "-q", "bridge");
      if (!value || value.includes("\n"))
        throw new Error("Expected one running bridge.");
      return value;
    };
    const verify = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          containerNode(
            id(),
            `import {readFileSync} from 'node:fs'; const token=readFileSync(process.env.CODEX_BRIDGE_TOKEN_FILE,'utf8').trim(); for(const p of ['/ready','/v1/models']) {const r=await fetch('http://127.0.0.1:8080'+p,{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)}); if(!r.ok) throw new Error('probe failed');}`,
          );
          return;
        } catch {
          await delay(5000);
        }
      }
      throw new Error("Deployment readiness check failed.");
    };
    const replace = () =>
      compose(
        "up",
        "-d",
        "--no-build",
        "--force-recreate",
        "bridge",
        "gateway",
      );
    const maintenance = (enabled) => {
      const source = enabled
        ? "import {writeFileSync} from 'node:fs'; writeFileSync('/data/state/update-maintenance','scheduled update',{flag:'wx',mode:0o600});"
        : "import {rmSync} from 'node:fs'; rmSync('/data/state/update-maintenance',{force:true});";
      if (enabled) containerNode(id(), source);
      else {
        try {
          containerNode(id(), source);
        } catch {
          compose(
            "run",
            "--rm",
            "--no-deps",
            "--entrypoint",
            "node",
            "bridge",
            "--input-type=module",
            "-e",
            source,
          );
        }
      }
    };
    const rollbackTo = (old) => {
      run("docker", ["tag", old.Image, old.Config.Image]);
      replace();
    };
    if (!scheduled) {
      const running = compose("ps", "-q", "bridge");
      const old = running
        ? JSON.parse(run("docker", ["inspect", running]))[0]
        : undefined;
      if (running && health(running).active !== 0)
        throw new Error("Bridge is busy; retry deployment when idle.");
      compose("build", "bridge");
      if (running) {
        const status = health(running);
        if (status.active !== 0 || status.maintenance === true)
          throw new Error(
            "Bridge became busy or entered maintenance; retry when idle.",
          );
        if (status.maintenance === false) {
          const changed = await deployWhenIdle({
            maintenance,
            idle: () => health(running).active === 0,
            deploy: replace,
            verify,
            rollback: () => rollbackTo(old),
          });
          if (!changed)
            throw new Error("Bridge became busy; retry deployment when idle.");
        } else {
          // shortcut: older bridges lack admission control; bootstrap during an idle maintenance window.
          try {
            replace();
            await verify();
          } catch (error) {
            rollbackTo(old);
            await verify();
            throw error;
          }
        }
      } else {
        replace();
        await verify();
      }
      install(args);
      process.stdout.write(
        "Deployment ready; nightly idle updates installed for 00:00 host local time.\n",
      );
      return;
    }
    const initial = health(id());
    if (
      initial.ready !== true ||
      initial.active !== 0 ||
      initial.maintenance !== false
    )
      return;
    const version = JSON.parse(
      run("npm", ["view", "@openai/codex@latest", "version", "--json"]),
    );
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version))
      throw new Error("Invalid stable version.");
    const current = containerNode(
      id(),
      `import {execFileSync} from 'node:child_process'; console.log(execFileSync(process.execPath,['node_modules/@openai/codex/bin/codex.js','--version'],{encoding:'utf8'}).trim());`,
    );
    if (!newerVersion(current.trim().replace(/^codex-cli /, ""), version))
      return;
    directory = mkdtempSync(join(tmpdir(), "bridge-upgrade-"));
    const old = JSON.parse(run("docker", ["inspect", id()]))[0];
    const candidateImage = `${config.name}-bridge-update:${version}`;
    candidate(
      directory,
      version,
      candidateImage,
      config.services.bridge.build?.args,
    );
    const before = health(id());
    if (
      before.ready !== true ||
      before.active !== 0 ||
      before.maintenance !== false
    )
      return;
    const target = old.Config.Image;
    const changed = await deployWhenIdle({
      maintenance,
      async idle() {
        // The gate is checked synchronously before admission, so all previously admitted work is visible.
        for (let i = 0; i < 12; i++) {
          const status = health(id());
          if (
            status.ready !== true ||
            status.maintenance !== true ||
            !Number.isSafeInteger(status.active)
          )
            throw new Error("Cannot confirm maintenance/idle state.");
          if (status.active === 0) return true;
          await delay(5000);
        }
        return false;
      },
      deploy() {
        run("docker", ["tag", candidateImage, target]);
        replace();
      },
      verify,
      rollback() {
        rollbackTo(old);
      },
    });
    if (changed)
      process.stdout.write(
        `Deployed Codex ${version} at ${new Date().toISOString()}\n`,
      );
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
