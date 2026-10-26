import { applyEdits, format, parse } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

/** One step of a line diff: a line both sides keep, one only `before` has, or one only `after` has. */
export type DiffKind = "same" | "remove" | "add";

/** Changed lines that sit together, with where they start on each side (1-based) and how many there are. */
export interface DiffHunk {
    beforeStart: number;
    beforeCount: number;
    afterStart: number;
    afterCount: number;
    lines: { kind: "remove" | "add"; text: string }[];
}

/**
 * The edit script turning `before` into `after`, line by line: Myers' shortest edit script,
 * after matching the common start and end. A settings change touches a few lines of a file
 * that can run to thousands, so what is left between those ends stays small.
 */
export function diffLines(before: string[], after: string[]): DiffKind[] {
    let start = 0;
    while(start < before.length && start < after.length && before[start] === after[start]) {
        start += 1;
    }
    let end = 0;
    while(end < before.length - start && end < after.length - start
        && before[before.length - 1 - end] === after[after.length - 1 - end]) {
        end += 1;
    }
    const a = before.slice(start, before.length - end);
    const b = after.slice(start, after.length - end);

    // (1) Forward: the furthest x reached on each diagonal k = x - y, per number of edits d
    const n = a.length;
    const m = b.length;
    const offset = n + m + 1;
    const v = new Array<number>(2 * offset + 1).fill(0);
    const trace: number[][] = [];
    let reached = n == 0 && m == 0;
    for(let d = 0; d <= n + m && reached == false; d += 1) {
        trace.push(v.slice());
        for(let k = -d; k <= d; k += 2) {
            let x = v[offset + k - 1] + 1;
            if(k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1])) {
                x = v[offset + k + 1];
            }
            let y = x - k;
            while(x < n && y < m && a[x] === b[y]) {
                x += 1;
                y += 1;
            }
            v[offset + k] = x;
            if(x >= n && y >= m) {
                reached = true;
                break;
            }
        }
    }

    // (2) Back from the end through each d's diagonals, collecting the steps in reverse
    const steps: DiffKind[] = [];
    let x = n;
    let y = m;
    for(let d = trace.length - 1; d >= 0; d -= 1) {
        const previous = trace[d];
        const k = x - y;
        let previousK = k - 1;
        if(k == -d || (k != d && previous[offset + k - 1] < previous[offset + k + 1])) {
            previousK = k + 1;
        }
        const previousX = previous[offset + previousK];
        const previousY = previousX - previousK;
        while(x > previousX && y > previousY) {
            steps.push("same");
            x -= 1;
            y -= 1;
        }
        // a step down the grid adds a line of `after`; one across removes a line of `before`
        if(d > 0 && x == previousX) {
            steps.push("add");
        }
        else if(d > 0) {
            steps.push("remove");
        }
        x = previousX;
        y = previousY;
    }
    return [...new Array<DiffKind>(start).fill("same"), ...steps.reverse(), ...new Array<DiffKind>(end).fill("same")];
}

/** A file's lines as an editor shows them: no byte order mark, either line ending, no empty last line. */
function linesOf(text: string): string[] {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    if(lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
    }
    return lines;
}

/**
 * The changed lines only, in hunks. A settings file holds other servers' entries, secrets among
 * them, so the lines around a change are left out rather than shown as context.
 */
export function changedHunks(before: string, after: string): DiffHunk[] {
    const beforeLines = linesOf(before);
    const afterLines = linesOf(after);
    const hunks: DiffHunk[] = [];
    let beforeIndex = 0;
    let afterIndex = 0;
    let current: DiffHunk | null = null;
    for(const step of diffLines(beforeLines, afterLines)) {
        if(step == "same") {
            current = null;
            beforeIndex += 1;
            afterIndex += 1;
            continue;
        }
        if(current == null) {
            current = { beforeStart: beforeIndex + 1, beforeCount: 0, afterStart: afterIndex + 1, afterCount: 0, lines: [] };
            hunks.push(current);
        }
        if(step == "remove") {
            current.lines.push({ kind: "remove", text: beforeLines[beforeIndex] });
            current.beforeCount += 1;
            beforeIndex += 1;
        }
        else {
            current.lines.push({ kind: "add", text: afterLines[afterIndex] });
            current.afterCount += 1;
            afterIndex += 1;
        }
    }
    return hunks;
}

/**
 * What a settings file's preview compares. A JSON file goes through the JSON formatter (two-space
 * indent, one value per line, comments kept), so a file kept on one line shows the values that
 * change instead of the whole file as one changed line (UI review, 2026-10-27). `formatted` is
 * set when the lines differ from the file's own, so their numbers are not the file's.
 */
export function comparableText(filePath: string, text: string): { text: string; formatted: boolean } {
    if(filePath.toLowerCase().endsWith(".json") == false || text.trim() === "") {
        return { text: text, formatted: false };
    }
    const source = text.replace(/^﻿/, "");
    const errors: ParseError[] = [];
    parse(source, errors, { allowTrailingComma: true });
    if(errors.length > 0) {
        return { text: text, formatted: false };
    }
    const formatted = applyEdits(source, format(source, undefined, { insertSpaces: true, tabSize: 2, eol: "\n" }));
    const same = linesOf(formatted).join("\n") == linesOf(text).join("\n");
    return { text: formatted, formatted: same == false };
}

/** `@@ -57 +57 @@` as git writes it: a count of one is left out, and a side with none names the line before. */
export function hunkHeader(hunk: DiffHunk): string {
    const side = (start: number, count: number) => {
        if(count == 0) {
            return `${start - 1},0`;
        }
        if(count == 1) {
            return `${start}`;
        }
        return `${start},${count}`;
    };
    return `@@ -${side(hunk.beforeStart, hunk.beforeCount)} +${side(hunk.afterStart, hunk.afterCount)} @@`;
}

/** `"DB_PASSWORD": "…"` in JSON and `API_TOKEN = "…"` in TOML; group 1 keeps the name, group 2 the quote. */
const SECRET_JSON = /("[^"\n]*(?:pass|secret|token|api[_-]?key|auth|credential)[^"\n]*"\s*:\s*)"(?:[^"\\\n]|\\.)*"/gi;
const SECRET_TOML = /^(\s*["']?[\w.-]*(?:pass|secret|token|api[_-]?key|auth|credential)[\w.-]*["']?\s*=\s*)(["']).*\2/i;

/** Hides values whose names look secret, in case a neighbouring entry's line changes with concos's own. */
export function maskSecrets(line: string): string {
    return line.replace(SECRET_JSON, "$1\"***\"").replace(SECRET_TOML, "$1$2***$2");
}
