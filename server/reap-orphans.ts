import type { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { ancestry, readCmdline, readStartTimeMs } from "./proc";

/**
 * Reap browsers that agents launched detached and then abandoned.
 *
 * A shell tool can leave a browser behind (`nohup google-chrome --user-data-dir=
 * /tmp/opencode/...`): it survives the OpenCode server stop, so nothing else ever
 * collects it. Killing on age alone is wrong — an agent may still be driving it —
 * so a browser is only reaped when the session that launched it is archived in
 * Paseo, and nothing is currently connected to its debugging port.
 */

const SCRATCH_ROOT = "/tmp/opencode";
const REAP_INTERVAL_MS = 10 * 60_000;
const REAP_MIN_AGE_MS = 10 * 60_000;
// A session that could have run the spawn must have been touched this close to it.
const SESSION_WINDOW_MS = 15 * 60_000;
const TERM_WAIT_MS = 10_000;

type DetachedBrowser = {
  dir: string;
  pids: number[];
  startedAt: number;
  debugPort: number;
  ownedByDaemon: boolean;
};

const paseoHome = () => process.env.PASEO_HOME ?? join(process.env.HOME ?? "", ".paseo");
const openCodeDbPath = () =>
  join(process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local/share"), "opencode/opencode.db");

/** Detached browsers whose profile lives in the OpenCode scratch directory. */
function findDetachedBrowsers(daemonPid: number): DetachedBrowser[] {
  const groups = new Map<string, DetachedBrowser>();
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    const cmdline = readCmdline(pid);
    if (!cmdline.includes("--user-data-dir=")) continue;
    const dir = /--user-data-dir=(\S+)/.exec(cmdline)?.[1];
    if (!dir || !dir.startsWith(`${SCRATCH_ROOT}/`)) continue;
    const port = Number(/--remote-debugging-port=(\d+)/.exec(cmdline)?.[1] ?? Number.NaN);
    if (!Number.isInteger(port)) continue;

    const startedAt = readStartTimeMs(pid);
    if (startedAt === null) continue;

    const owned = ancestry(pid).includes(daemonPid);
    const group = groups.get(dir);
    if (!group) {
      groups.set(dir, { dir, pids: [pid], startedAt, debugPort: port, ownedByDaemon: owned });
      continue;
    }
    group.pids.push(pid);
    group.startedAt = Math.min(group.startedAt, startedAt);
    group.ownedByDaemon ||= owned;
  }

  return [...groups.values()];
}

/** True while any process holds an established connection to the debugging port. */
function hasClient(port: number): boolean {
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let table: string;
    try {
      table = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of table.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10) continue;
      if (Number.parseInt(cols[1].split(":")[1], 16) !== port) continue;
      if (cols[3] !== "01") continue; // TCP_ESTABLISHED
      if (cols[9] !== "0") inodes.add(cols[9]);
    }
  }
  if (inodes.size === 0) return false;

  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true; // blind: assume in use
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      const socket = /^socket:\[(\d+)\]$/.exec(target);
      if (socket && inodes.has(socket[1])) return true;
    }
  }
  return false;
}

let DatabaseSyncCtor: typeof DatabaseSync | null | undefined;

/**
 * Loaded on demand, not statically: node:sqlite only exists on Node >= 22.5, and this
 * plugin's idle stop must keep working on a host that lacks it.
 */
async function loadSqlite(): Promise<typeof DatabaseSync | null> {
  if (DatabaseSyncCtor !== undefined) return DatabaseSyncCtor;
  try {
    DatabaseSyncCtor = (await import("node:sqlite")).DatabaseSync;
  } catch {
    DatabaseSyncCtor = null;
  }
  return DatabaseSyncCtor;
}

/** Sessions alive when the browser started whose messages contain its launch command. */
async function spawningSessions(dir: string, startedAt: number): Promise<string[] | null> {
  const Database = await loadSqlite();
  if (Database === null) return null;

  let db: DatabaseSync;
  try {
    db = new Database(openCodeDbPath(), { readOnly: true });
  } catch {
    return null;
  }

  try {
    const candidates = db
      .prepare("select id from session_v2 where time_created <= ? and time_updated >= ?")
      .all(startedAt, startedAt - SESSION_WINDOW_MS) as { id: string }[];
    const fragment = `%--user-data-dir=${dir}%`;
    const inMessages = db.prepare(
      "select 1 from session_message where session_id = ? and data like ? limit 1",
    );
    const inParts = db.prepare("select 1 from part where session_id = ? and data like ? limit 1");

    const sessions: string[] = [];
    for (const { id } of candidates) {
      if (inMessages.get(id, fragment) ?? inParts.get(id, fragment)) sessions.push(id);
    }
    return sessions;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Paseo's archive flag per OpenCode session id; `null` means the agent is live. */
function sessionArchiveState(): Map<string, string | null> {
  const state = new Map<string, string | null>();
  const root = join(paseoHome(), "agents");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return state;
  }

  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(join(root, dir));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const agent = JSON.parse(readFileSync(join(root, dir, file), "utf8")) as {
          archivedAt?: string | null;
          runtimeInfo?: { sessionId?: string };
        };
        const sessionId = agent.runtimeInfo?.sessionId;
        if (sessionId) state.set(sessionId, agent.archivedAt ?? null);
      } catch {
        continue;
      }
    }
  }
  return state;
}

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function terminate(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  const deadline = Date.now() + TERM_WAIT_MS;
  let left = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  while (left.length > 0 && Date.now() < deadline) {
    await sleep(250);
    left = left.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  }
  for (const pid of left) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

let reaping = false;
const reported = new Set<string>();

/** One pass; exported so the reaping rule can be exercised without waiting. */
export async function reapArchivedOrphans(daemonPid: number = process.ppid): Promise<void> {
  if (reaping) return;
  reaping = true;
  try {
    const browsers = findDetachedBrowsers(daemonPid);
    if (browsers.length === 0) return;

    const archiveState = sessionArchiveState();
    for (const browser of browsers) {
      if (browser.ownedByDaemon) continue;
      if (Date.now() - browser.startedAt < REAP_MIN_AGE_MS) continue;

      if (hasClient(browser.debugPort)) {
        if (!reported.has(browser.dir)) {
          reported.add(browser.dir);
          console.log(`[reap] ${browser.dir} still has a client on port ${browser.debugPort}; leaving it`);
        }
        continue;
      }

      const sessions = await spawningSessions(browser.dir, browser.startedAt);
      if (sessions === null) {
        if (!reported.has(browser.dir)) {
          reported.add(browser.dir);
          console.log(`[reap] cannot read the OpenCode session store; leaving ${browser.dir}`);
        }
        continue;
      }
      if (sessions.length === 0) {
        if (!reported.has(browser.dir)) {
          reported.add(browser.dir);
          console.log(`[reap] no session claims ${browser.dir}; leaving it`);
        }
        continue;
      }

      const live = sessions.filter((sessionId) => !archiveState.get(sessionId));
      if (live.length > 0) {
        if (!reported.has(browser.dir)) {
          reported.add(browser.dir);
          console.log(`[reap] ${browser.dir} was launched by a live session (${live.join(",")}); leaving it`);
        }
        continue;
      }

      reported.delete(browser.dir);
      console.log(
        `[reap] stopping detached browser ${browser.dir} pids=${browser.pids.join(",")} ` +
          `spawnedBy=${sessions.join(",")}`,
      );
      await terminate(browser.pids);
      console.log(`[reap] detached browser ${browser.dir} stopped`);
    }
  } finally {
    reaping = false;
  }
}

export function startOrphanReaper(): () => void {
  console.log(
    `[reap] started interval=${REAP_INTERVAL_MS / 60_000}m minAge=${REAP_MIN_AGE_MS / 60_000}m ` +
      `scratch=${SCRATCH_ROOT} db=${openCodeDbPath()}`,
  );
  const first = setTimeout(() => void reapArchivedOrphans(), 60_000);
  const timer = setInterval(() => void reapArchivedOrphans(), REAP_INTERVAL_MS);
  timer.unref?.();
  first.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
