/**
 * Transport registry — creates and wires all transports from config.
 */

import { loadConfig } from "../config";
import { TransportRouter } from "../transport";
import { TmuxTransport } from "./tmux";
import { MqttTransport } from "./mqtt";
import { HttpTransport } from "./http";
import type { MqttConfig } from "./mqtt";

/** Singleton router instance */
let router: TransportRouter | null = null;

/** Build transport router from maw.config.json */
export function createTransportRouter(): TransportRouter {
  if (router) return router;

  const config = loadConfig();
  router = new TransportRouter();

  // 1. Always register tmux (local fast path) — auto-connected
  const tmux = new TmuxTransport();
  tmux.connect(); // tmux is always available locally
  router.register(tmux);

  // 2. MQTT if configured
  const mqttConfig = (config as any).mqtt as Partial<MqttConfig> | undefined;
  if (mqttConfig?.broker) {
    router.register(
      new MqttTransport({
        broker: mqttConfig.broker,
        clientId: mqttConfig.clientId,
        username: mqttConfig.username,
        password: mqttConfig.password,
        selfName: config.host || "maw",
        selfHost: config.host || "local",
      }),
    );
  }

  // 3. HTTP federation as fallback
  if (config.peers && config.peers.length > 0) {
    router.register(
      new HttpTransport({
        peers: config.peers,
        selfHost: config.host || "local",
      }),
    );
  }

  return router;
}

/** Get existing router or create one */
export function getTransportRouter(): TransportRouter {
  return router || createTransportRouter();
}

/** Reset (for config reload) */
export function resetTransportRouter() {
  if (router) {
    router.disconnectAll().catch(() => {});
    router = null;
  }
}

export { TmuxTransport } from "./tmux";
export { MqttTransport } from "./mqtt";
export { HttpTransport } from "./http";
