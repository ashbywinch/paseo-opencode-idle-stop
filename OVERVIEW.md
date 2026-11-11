# OpenCode idle stop

Stops the shared OpenCode server Paseo keeps warm once every agent has been idle for an hour,
so the MCP servers it spawns per project directory are released.

Paseo deliberately holds one OpenCode server open at zero leases to avoid a cold start. That
server keeps one MCP client process per directory for its whole lifetime and never evicts them,
so memory grows with every directory and worktree used in a session. Stopping the server is a
supported recovery path: sessions reconnect transparently on their next operation, and OpenCode's
normal shutdown terminates the MCP process group.

The plugin only acts when nothing has happened for an hour *and* the OpenCode server wrote no
log line in that window, and it only signals a process descended from the daemon it runs in.
Hook silence alone is not proof of idleness: a cancelled turn can skip `agent.turn.after`, so
an open turn record may be stale, and on 2026-11-09 exactly that pinned the server open for 11
hours. The server's own log writes now decide whether work is really happening — an idle server
writes nothing while a working one writes constantly, whereas CPU use does not separate them
(an idle server still burns ~1%). A stop therefore never interrupts a running turn, and the
next message pays a cold start of a few seconds.

It starts in dry-run mode and only logs what it would stop. Set `DRY_RUN` to `false` in
`server/idle-stop.ts` and reload the plugin to enable it.

Stopping the server does not collect a browser an agent left behind: a shell tool that runs
`nohup google-chrome --user-data-dir=/tmp/opencode/...` detaches it from the process group, so it
outlives every stop. The plugin also reaps those, under a stricter rule than idleness — the
browser's profile must sit under `/tmp/opencode`, nothing may be connected to its
`--remote-debugging-port`, and the OpenCode session whose recorded command launched it must be
archived in Paseo (`archivedAt` in `$PASEO_HOME/agents`). A browser whose launching session is
still live, or that cannot be attributed to any session, is left alone.
