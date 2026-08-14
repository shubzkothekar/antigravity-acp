// A proxy entrypoint that self-cancels the way a broken control pipe makes the
// real proxy self-cancel — but only on its first invocation. The second run
// delegates to the real proxy, so spawnAgy() must retry to succeed.
import { existsSync, writeFileSync } from "node:fs";
import { runAgyProcessProxy } from "../../src/agy/process";

const marker = process.env.AGY_ACP_FLAKY_PROXY_MARKER as string;
if (!existsSync(marker)) {
	writeFileSync(marker, "tripped");
	process.exit(130);
}
process.exit(await runAgyProcessProxy(process.argv[3]));
