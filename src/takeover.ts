import type { TakeoverInput } from "./modules/mcp/handoff";

/**
 * Loaded by a running bridge of an older concos (0.1.19 on) into its own process when this version
 * is installed under it: this version's bridge takes the client over there, so an update adds no
 * process. `cli.js` is not the entry for this, since loading it would run the command line.
 */
export async function takeOver(input: TakeoverInput): Promise<void> {
    if(input.protocol != 1) {
        throw new Error(`unknown takeover protocol ${String(input.protocol)}`);
    }
    const { runBridge } = await import("./modules/mcp/bridge");
    await runBridge({ takeover: input });
}
