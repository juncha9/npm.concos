import fs from "node:fs";
import type { ContextSize } from "../types";

/**
 * How much of a client's record a turn-end hook reads, from its end: the last call's line is
 * usually within the first, but one long tool result after it can push it back. Records run to
 * tens of megabytes (15 MB on 2026-10-29), so the whole file is never read.
 */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024];

/**
 * The newest line of a JSON-lines record for which `pick` gives a size, reading only the file's
 * tail. A line cut by the start of the tail is skipped. Null when no line in the tail gives one,
 * or the file cannot be read.
 */
export function newestContextSize(file: string, pick: (record: Record<string, unknown>) => ContextSize | null): ContextSize | null {
    let handle: number;
    try {
        handle = fs.openSync(file, "r");
    }
    catch {
        return null;
    }
    try {
        const size = fs.fstatSync(handle).size;
        for(const bytes of TAIL_BYTES) {
            const start = Math.max(0, size - bytes);
            const buffer = Buffer.alloc(size - start);
            fs.readSync(handle, buffer, 0, buffer.length, start);
            const lines = buffer.toString("utf8").split("\n");
            if(start > 0) {
                lines.shift();
            }
            for(let index = lines.length - 1; index >= 0; index--) {
                const line = lines[index].trim();
                if(line == "") {
                    continue;
                }
                let record: unknown;
                try {
                    record = JSON.parse(line);
                }
                catch {
                    continue;
                }
                if(record == null || typeof record != "object" || Array.isArray(record)) {
                    continue;
                }
                const found = pick(record as Record<string, unknown>);
                if(found != null) {
                    return found;
                }
            }
            if(start == 0) {
                break;
            }
        }
        return null;
    }
    catch {
        return null;
    }
    finally {
        fs.closeSync(handle);
    }
}

/** A non-negative whole number from a record field, or null. */
export function tokenCount(value: unknown): number | null {
    return typeof value == "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
