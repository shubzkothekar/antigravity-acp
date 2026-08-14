// A proxy entrypoint that signals "locked" and then stalls without ever
// signalling "ready", so spawnAgy() has to hit its handshake deadline.
// It exits on its own so a missed kill can never leave it holding the
// handshake pipes open for the rest of the suite.
import { writeSync } from "node:fs";

writeSync(3, "locked\n");
await Bun.sleep(5000);
