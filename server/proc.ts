import { readFileSync } from "node:fs";

export function readCmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
  } catch {
    return "";
  }
}

export function readPpid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(tail[1]);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** Start time in epoch milliseconds, from /proc/<pid>/stat plus boot time. */
export function readStartTimeMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const boot = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
    if (!Number.isFinite(ticks) || boot === undefined) return null;
    return Number(boot) * 1_000 + (ticks * 1_000) / 100;
  } catch {
    return null;
  }
}

export function ancestry(pid: number): number[] {
  const chain: number[] = [];
  let current: number | null = pid;
  while (current !== null && current > 1 && !chain.includes(current)) {
    chain.push(current);
    current = readPpid(current);
  }
  return chain;
}
