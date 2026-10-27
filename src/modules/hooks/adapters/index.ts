import { RoomError } from "../../store/room-error";
import type { HostAdapter } from "../types";
import { claude } from "./claude";
import { codex } from "./codex";
import { gemini } from "./gemini";
import { cursor } from "./cursor";
import { copilot } from "./copilot";

export const HOST_ADAPTERS = [claude, codex, gemini, cursor, copilot];

export function getHostAdapter(host: string | undefined) {
    const adapter = HOST_ADAPTERS.find((item) => item.id == host);
    if(adapter == null) throw new RoomError(`--host must be one of ${HOST_ADAPTERS.map((item) => item.id).join(", ")}`);
    return adapter;
}

/** The process id `adapter`'s client names in this process's environment, when it names a valid one. */
export function clientPidFromEnvironment(adapter: HostAdapter): number | undefined {
    if(adapter.clientPidVariable == null) {
        return undefined;
    }
    const named = Number(process.env[adapter.clientPidVariable]);
    if(Number.isInteger(named) && named > 0) {
        return named;
    }
    return undefined;
}
