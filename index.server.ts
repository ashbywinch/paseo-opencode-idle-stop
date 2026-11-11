import type { PluginServerContext } from "@getpaseo/plugin/server";
import { startIdleStop } from "./server/idle-stop";
import { startOrphanReaper } from "./server/reap-orphans";

export default function contribute(server: PluginServerContext) {
  const stopIdleStop = startIdleStop(server);
  const stopReaper = startOrphanReaper();
  return () => {
    stopIdleStop();
    stopReaper();
  };
}
