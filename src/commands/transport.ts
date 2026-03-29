/**
 * maw transport status — show transport layer connectivity.
 */

import { getTransportRouter } from "../transports";
import { loadConfig } from "../config";

export async function cmdTransportStatus() {
  const config = loadConfig() as any;
  const router = getTransportRouter();

  console.log(`\n\x1b[36;1mTransport Status\x1b[0m\n`);

  const statuses = router.status();

  for (const t of statuses) {
    const dot = t.connected ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    const status = t.connected ? "\x1b[32mconnected\x1b[0m" : "\x1b[31mdisconnected\x1b[0m";
    console.log(`  ${dot}  \x1b[37m${t.name.padEnd(20)}\x1b[0m  ${status}`);
  }

  // Show config hints for unconfigured transports
  if (!config.mqtt?.broker) {
    console.log(`\n  \x1b[90mMQTT not configured. Add to maw.config.json:\x1b[0m`);
    console.log(`  \x1b[90m  "mqtt": { "broker": "ws://signal.oraclenet.org:9001" }\x1b[0m`);
  }

  if (!config.avengers) {
    console.log(`\n  \x1b[90mAvengers not configured. Add to maw.config.json:\x1b[0m`);
    console.log(`  \x1b[90m  "avengers": "http://white.local:8090"\x1b[0m`);
  }

  if (!config.peers?.length) {
    console.log(`\n  \x1b[90mNo federation peers. Add to maw.config.json:\x1b[0m`);
    console.log(`  \x1b[90m  "peers": ["http://other-host:3456"]\x1b[0m`);
  }

  console.log();
}
