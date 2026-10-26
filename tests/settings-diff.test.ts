import { describe, expect, it } from "vitest";
import { changedHunks, comparableText, diffLines, hunkHeader, maskSecrets } from "../src/modules/cli/settings-diff";

describe("settings diff", () => {
    it("finds the shortest edit between two line lists", () => {
        expect(diffLines(["a", "b", "c"], ["a", "x", "c"])).toEqual(["same", "remove", "add", "same"]);
        expect(diffLines(["a", "c"], ["a", "b", "c"])).toEqual(["same", "add", "same"]);
        expect(diffLines(["a", "b", "c"], ["a", "c"])).toEqual(["same", "remove", "same"]);
        expect(diffLines([], ["a", "b"])).toEqual(["add", "add"]);
        expect(diffLines(["a"], ["a"])).toEqual(["same"]);
    });

    it("shows a changed value as one hunk, with git's header and none of the lines around it", () => {
        const before = '{\r\n  "hooks": {\r\n    "timeout": 3660,\r\n    "asyncRewake": true\r\n  }\r\n}\r\n';
        const after = before.replace("3660", "86460");
        const hunks = changedHunks(before, after);
        expect(hunks).toHaveLength(1);
        expect(hunkHeader(hunks[0])).toBe("@@ -3 +3 @@");
        expect(hunks[0].lines).toEqual([{ kind: "remove", text: '    "timeout": 3660,' }, { kind: "add", text: '    "timeout": 86460,' }]);
    });

    it("shows a new file as added lines, ignoring a byte order mark", () => {
        const hunks = changedHunks("", '﻿{\n  "a": 1\n}\n');
        expect(hunks.map(hunkHeader)).toEqual(["@@ -0,0 +1,3 @@"]);
        expect(hunks[0].lines.map((line) => line.text)).toEqual(["{", '  "a": 1', "}"]);
    });

    it("keeps two distant changes in a large file apart, quickly", () => {
        const before = Array.from({ length: 6000 }, (_, index) => `line ${index}`);
        const after = [...before];
        after[10] = "changed near the start";
        after[5990] = "changed near the end";
        const startedMs = Date.now();
        const hunks = changedHunks(before.join("\n"), after.join("\n"));
        expect(Date.now() - startedMs).toBeLessThan(1000);
        expect(hunks.map(hunkHeader)).toEqual(["@@ -11 +11 @@", "@@ -5991 +5991 @@"]);
    });

    it("compares JSON settings formatted, keeping comments, and leaves other files and broken JSON as they are", () => {
        const oneLine = JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: "concos hook watch", timeout: 3660 }] }] } });
        const before = comparableText("C:/u/.claude/settings.json", oneLine);
        const after = comparableText("C:/u/.claude/settings.json", oneLine.replace("3660", "86460"));
        expect(before.formatted).toBe(true);
        expect(changedHunks(before.text, after.text).flatMap((hunk) => hunk.lines.map((line) => line.text.trim()))).toEqual(['"timeout": 3660', '"timeout": 86460']);
        // a file already in that form keeps its own line numbers
        expect(comparableText("settings.json", `${before.text}\n`).formatted).toBe(false);
        expect(comparableText("hooks.json", '{ // concos\n"a": 1 }').text).toContain("// concos");
        expect(comparableText("config.toml", "a = 1")).toEqual({ text: "a = 1", formatted: false });
        expect(comparableText("settings.json", '{"a": ')).toEqual({ text: '{"a": ', formatted: false });
    });

    it("hides values whose names look secret, in JSON and TOML, and leaves the rest", () => {
        expect(maskSecrets('      "DB_PASSWORD": "hunter2",')).toBe('      "DB_PASSWORD": "***",');
        expect(maskSecrets('"apiKey": "abc", "name": "x"')).toBe('"apiKey": "***", "name": "x"');
        expect(maskSecrets('GITHUB_TOKEN = "ghp_123"')).toBe('GITHUB_TOKEN = "***"');
        expect(maskSecrets('      "command": "concos hook watch --host claude",')).toBe('      "command": "concos hook watch --host claude",');
    });
});
