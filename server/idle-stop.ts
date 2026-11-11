import { readdirSync, readlinkSync, statSync } from "node:fs";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ancestry, readCmdline } from "./proc";

/**
 * Stop the OpenCode server Paseo keeps warm once every agent has been idle.
 *
 * Paseo keeps one shared OpenCode server alive at zero leases on purpose, to avoid
 * a cold start. That server holds one MCP client process per project directory and
 * never evicts them (OpenCode issue #21557, closed not planned). Stopping the server
 * is a supported recovery path: sessions call reconnectIfExited() before every
 * operation and re-acquire a fresh generation, and OpenCode's normal shutdown kills
 * the MCP process group.
 *
 * Safety: it only signals a process descended from this daemon, and only when
 * nothing has happened for IDLE_MS *and* the server has not written a log line in
 * that window. Log silence is the liveness check: `agent.turn.after` is not
 * guaranteed for a cancelled turn, so a turn record alone cannot prove a turn is
 * still running — and a stale record must not pin the server open forever. CPU use
 * cannot be used instead: an idle server burns ~1% CPU, while an idle server writes
 * nothing and a working one writes constantly.
 */

const IDLE_MS = 60 * 60_000; // 1 hour with no turn, open or close
const TICK_MS = 30_000;
const TERM_WAIT_MS = 10_000;

// Flip to false once the dry-run output has proven detection on this machine.
const DRY_RUN = false;

/** Identity of every log the server holds open; changes on any write. */
function readLogFingerprint(pid: number): string | null {
  const parts: string[] = [];
  try {
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      let target: string;
      try {
        target = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!target.includes("/log/") || !target.endsWith(".log")) continue;
      try {
        const stat = statSync(target);
        parts.push(`${target}:${stat.size}:${stat.mtimeMs}`);
      } catch {
        parts.push(`${target}:gone`);
      }
    }
  } catch {
    return null;
  }
  if (parts.length > 0) return parts.sort().join("|");

  // No log handle on the process: fall back to the default OpenCode log path.
  const dataHome = process.env.XDG_DATA_HOME ?? `${process.env.HOME}/.local/share`;
  const fallback = `${dataHome}/opencode/log/opencode.log`;
  try {
    const stat = statSync(fallback);
    return `${fallback}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** OpenCode servers that belong to this daemon. */
function findOwnedServers(): { pid: number; cmdline: string }[] {
  const daemonPid = process.ppid;
  let pids: string[];
  try {
    pids = readdirSync("/proc");
  } catch {
    return [];
  }

  const found: { pid: number; cmdline: string }[] = [];
  for (const entry of pids) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    const cmdline = readCmdline(pid);
    if (!cmdline.includes("opencode")) continue;
    if (!/\bserve\b/.test(cmdline)) continue;
    if (cmdline.includes("paseo-opencode-idle-stop")) continue;

    const chain = ancestry(pid);
    const owned =
      chain.includes(daemonPid) ||
      chain.some((ancestor) => /paseo daemon|Paseo Daemon/i.test(readCmdline(ancestor)));
    if (owned) found.push({ pid, cmdline });
  }
  return found;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopServer(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    console.log(`[idle-stop] could not signal ${pid}: ${String(error)}`);
    return false;
  }

  const deadline = Date.now() + TERM_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }

  try {
    process.kill(pid, "SIGKILL");
    console.log(`[idle-stop] ${pid} ignored SIGTERM; sent SIGKILL`);
  } catch {
    return true;
  }
  return true;
}

export function startIdleStop(server: Pick<PluginServerContext, "addHook">): () => void {
  // Turn start per agent. A record still open after IDLE_MS is suspect, not
  // authoritative: cancellation can skip `agent.turn.after`, so a record alone must
  // not block a stop — the server's own log decides that instead.
  const turns = new Map<string, number>();
  // Per server: last log fingerprint seen and when the current quiet window started.
  const logs = new Map<number, { fingerprint: string; quietSince: number } | null>();
  let lastActivity = Date.now();
  let stopping = false;

  const discovered = findOwnedServers();
  console.log(
    `[idle-stop] started id=${process.pid} daemon=${process.ppid} dryRun=${DRY_RUN} ` +
      `ownedOpenCode=${JSON.stringify(discovered.map((s) => s.pid))}`,
  );

  const touch = () => {
    lastActivity = Date.now();
  };

  server.addHook("agent.turn.before", async ({ agent }) => {
    turns.set(agent.id, Date.now());
    touch();
  });
  server.addHook("agent.turn.after", async ({ agent }) => {
    turns.delete(agent.id);
    touch();
  });
  server.addHook("agent.open.before", async () => {
    touch();
  });
  server.addHook("agent.close.after", async ({ agent }) => {
    turns.delete(agent.id);
    touch();
  });
  server.addHook("agent.archive.after", async ({ agent }) => {
    turns.delete(agent.id);
    touch();
  });

  /** Forget dead servers; restart the quiet window whenever a server writes a line. */
  const sampleLogs = (pids: number[]): void => {
    const live = new Set(pids);
    for (const pid of logs.keys()) if (!live.has(pid)) logs.delete(pid);

    const now = Date.now();
    for (const pid of pids) {
      const fingerprint = readLogFingerprint(pid);
      const entry = logs.get(pid);
      if (fingerprint === null) {
        if (!entry) {
          console.log(`[idle-stop] cannot read an opencode log for pid ${pid}; not stopping blind`);
        }
        logs.set(pid, null);
        continue;
      }
      if (!entry || entry.fingerprint !== fingerprint) {
        logs.set(pid, { fingerprint, quietSince: now });
      }
    }
  };

  /** Milliseconds since the quietest owned server last wrote; 0 when unobservable. */
  const quietFor = (pids: number[], now: number): number => {
    let quiet = Number.POSITIVE_INFINITY;
    for (const pid of pids) {
      const entry = logs.get(pid);
      if (!entry) return 0;
      quiet = Math.min(quiet, now - entry.quietSince);
    }
    return quiet;
  };

  const timer = setInterval(() => {
    void (async () => {
      if (stopping) return;

      const servers = findOwnedServers();
      if (servers.length === 0) {
        logs.clear();
        touch();
        return;
      }

      const now = Date.now();
      sampleLogs(servers.map((s) => s.pid));

      if (now - lastActivity < IDLE_MS) return;

      // A turn that started within the idle window may still be working: wait.
      for (const startedAt of turns.values()) {
        if (now - startedAt < IDLE_MS) return;
      }

      // The daemon may have gone quiet without a turn record ever closing, so the
      // server's own log writes are what prove nothing is in flight.
      const quiet = quietFor(servers.map((s) => s.pid), now);
      if (quiet < IDLE_MS) return;

      const idleFor = now - lastActivity;
      const age = Math.round(idleFor / 60_000);
      const quietMin = Math.round(quiet / 60_000);
      const stale = [...turns]
        .map(([id, startedAt]) => `${id}:${Math.round((now - startedAt) / 60_000)}m`)
        .join(",");
      const staleNote = stale ? ` staleTurns=${stale}` : "";

      for (const target of servers) {
        if (DRY_RUN) {
          console.log(
            `[idle-stop] DRY RUN: would stop opencode pid ${target.pid} after ${age}m idle, ` +
              `${quietMin}m without log writes${staleNote} (${target.cmdline})`,
          );
        } else {
          console.log(
            `[idle-stop] stopping opencode pid ${target.pid} after ${age}m idle, ` +
              `${quietMin}m without log writes${staleNote}`,
          );
          stopping = true;
          const ok = await stopServer(target.pid);
          stopping = false;
          console.log(`[idle-stop] opencode pid ${target.pid} stopped: ${ok}`);
        }
      }

      for (const [id, startedAt] of turns) {
        if (now - startedAt >= IDLE_MS) turns.delete(id);
      }
      logs.clear();

      // Avoid a tight loop while agents remain idle and a fresh server exists.
      touch();
    })();
  }, TICK_MS);
  timer.unref?.();

  return () => {
    clearInterval(timer);
  };
}
