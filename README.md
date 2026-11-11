# paseo-opencode-idle-stop

A Paseo server plugin that releases what a warm OpenCode server keeps hold of: it stops the
shared `opencode serve` process once every agent has been idle for an hour, and reaps browsers
that agent sessions launched detached and then abandoned.

Two behaviours, both conservative:

- **Idle stop.** Stops the OpenCode server Paseo keeps warm at zero leases, which otherwise holds
  one MCP client process per project directory for its whole lifetime. Acts only when no agent
  turn has been seen for an hour *and* the server has written no log line in that window — a
  cancelled turn can skip `agent.turn.after`, so a turn record alone is not proof of work.
- **Orphan reap.** A shell tool can leave `nohup google-chrome --user-data-dir=/tmp/opencode/...`
  behind, detached from the server's process group, so it survives every stop. Those are killed
  only when the session whose recorded command launched them is archived in Paseo and nothing is
  connected to their debugging port. Unattributable or live-session browsers are left alone.

`OVERVIEW.md` explains the reasoning, the `#21557` MCP-retention problem it works around, and the
stale-turn failure that motivated the log-silence rule.

## Install

```bash
paseo plugin install /path/to/paseo-opencode-idle-stop
paseo plugin reload paseo-opencode-idle-stop
paseo plugin logs paseo-opencode-idle-stop
```

Refresh after editing the sources with `paseo plugin reload paseo-opencode-idle-stop`; a daemon
restart also reloads it.

## Requirements

- Paseo `>= 0.15.3` (hooks used: `agent.turn.*`, `agent.open.before`, `agent.close.after`,
  `agent.archive.after`).
- Linux, for `/proc` (process ancestry, open file descriptors, socket inodes).
- Node `>= 22.5` for the reaper's session lookup (`node:sqlite`). Without it the reaper stays
  inert and the idle stop still works.

## Configuration

Constants at the top of each module; there is no settings UI.

| Constant | Module | Default |
| --- | --- | --- |
| `IDLE_MS` | `server/idle-stop.ts` | 1 hour |
| `TICK_MS` | `server/idle-stop.ts` | 30 s |
| `DRY_RUN` | `server/idle-stop.ts` | `false` |
| `REAP_INTERVAL_MS` | `server/reap-orphans.ts` | 10 min |
| `REAP_MIN_AGE_MS` | `server/reap-orphans.ts` | 10 min |
| `SCRATCH_ROOT` | `server/reap-orphans.ts` | `/tmp/opencode` |

Paths come from the environment Paseo launches plugins with: `PASEO_HOME` (agent records, read for
`archivedAt`) and `XDG_DATA_HOME` (OpenCode's session store).

## Layout

```
index.server.ts        plugin entry: starts both timers, returns one cleanup
server/idle-stop.ts    idle detection + SIGTERM of the owned OpenCode server
server/reap-orphans.ts archived-session check for detached browsers
server/proc.ts         /proc helpers (cmdline, ppid, ancestry, start time)
OVERVIEW.md            behaviour and rationale
```

## Development

```bash
make setup    # npm ci
make check    # tsc --noEmit — the gate CI runs
```

CI runs `make setup` then `make check` on Node 22.22.1 (pinned in `.nvmrc`, used by both the
workflow and local dev), on every push to `main` and every pull request.
