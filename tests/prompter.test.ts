import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Prompter, PromptBackError, PromptClosedError, displayWidth, supportsUnicode } from "../src/modules/cli/prompter";
import { TerminalScreen } from "./terminal-screen";

function terminal() {
    const raw: boolean[] = [];
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (mode: boolean) => { raw.push(mode); } });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 60 });
    let screen = "";
    output.on("data", (chunk) => { screen += chunk.toString(); });
    return { input, output, raw, screen: () => screen };
}

async function press(input: PassThrough, keys: string[]) {
    for(const key of keys) {
        input.write(key);
        await new Promise((resolve) => setImmediate(resolve));
    }
}

describe("terminal symbols", () => {
    it("lets CONCOS_UNICODE override the guess either way", () => {
        try {
            vi.stubEnv("CONCOS_UNICODE", "1");
            expect(supportsUnicode()).toBe(true);
            // a terminal that says it draws them is still told not to
            vi.stubEnv("WT_SESSION", "session");
            vi.stubEnv("CONCOS_UNICODE", "0");
            expect(supportsUnicode()).toBe(false);
        }
        finally { vi.unstubAllEnvs(); }
    });
});

describe("terminal prompts", () => {
    it("animates cached rows without fetching data or clearing the screen, and stops both timers on exit", async () => {
        vi.useFakeTimers();
        vi.stubEnv("CONCOS_REDUCED_MOTION", "0");
        vi.stubEnv("TERM", "xterm");
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        let frame = 0;
        const rows = [{ value: "a", label: "Agent", lines: () => [[{ text: `Agent frame ${frame}` }]] }];
        const load = vi.fn(() => ({ question: "Room", items: rows }));
        try {
            const pending = prompter.select("Room", rows, {
                refresh: { intervalMs: 1000, load },
                animation: { intervalMs: 40, frame: () => { frame += 1; return {}; } },
            });
            const initialLength = tty.screen().length;
            await vi.advanceTimersByTimeAsync(120);
            expect(load).not.toHaveBeenCalled();
            expect(tty.screen().slice(initialLength)).toMatch(/\u001b\[2K[^\n]*Agent frame/);
            expect(tty.screen().slice(initialLength)).not.toContain("\u001b[J");
            await vi.advanceTimersByTimeAsync(880);
            expect(load).toHaveBeenCalledTimes(1);
            expect(tty.screen().slice(initialLength)).not.toContain("\u001b[J");
            tty.input.write("\r");
            expect(await pending).toBe("a");
            const finishedLength = tty.screen().length;
            await vi.advanceTimersByTimeAsync(2000);
            expect(tty.screen().length).toBe(finishedLength);
            expect(load).toHaveBeenCalledTimes(1);
        }
        finally { prompter.close(); vi.useRealTimers(); vi.unstubAllEnvs(); }
    });

    it("traces draws and keys to CONCOS_BOARD_TRACE with values and counts, never row text", async () => {
        const traceFile = path.join(os.tmpdir(), `concos-trace-${process.pid}-${Date.now()}.jsonl`);
        vi.stubEnv("CONCOS_BOARD_TRACE", traceFile);
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const picked = prompter.select("Room", [
                { value: "agent:a", label: "Secret agent name", hint: "private hint" },
                { value: "agent:b", label: "Other agent" },
            ]);
            await press(tty.input, ["\u001b[B", "\r"]);
            expect(await picked).toBe("agent:b");
            const events = fs.readFileSync(traceFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
            expect(events.map((entry) => entry.event)).toEqual(expect.arrayContaining(["draw-full", "key"]));
            expect(events.find((entry) => entry.event == "key")).toMatchObject({ key: JSON.stringify("\u001b[B"), active: "agent:a" });
            expect(fs.readFileSync(traceFile, "utf8")).not.toMatch(/Secret agent name|private hint|Other agent/);
        }
        finally {
            prompter.close();
            vi.unstubAllEnvs();
            fs.rmSync(traceFile, { force: true });
        }
    });

    it("types into a row's text field before digits, j/k and Esc mean anything else, across a refresh", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        const field = { text: "", placeholder: "type to search" };
        // a refresh rebuilds the rows; the caller's field object carries the text over
        const rows = () => [
            { value: "send", label: "Send a message" },
            { value: "search", label: "Search messages", hint: "by text", input: field },
            { value: "back", label: "Back" },
        ];
        try {
            const picked = prompter.select("Messages", rows(), { defaultValue: "search", refresh: { intervalMs: 20, load: () => ({ question: "Messages", items: rows() }) } });
            await press(tty.input, ["n", "1", "j", "k", "x", "\u007f"]);
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(field.text).toBe("n1jk");
            expect(tty.screen().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")).toContain("Search messages  n1jk");
            // Esc clears the text first; the row stays
            await press(tty.input, ["\u001b"]);
            expect(field.text).toBe("");
            await press(tty.input, ["a", "b", "\r"]);
            expect(await picked).toBe("search");
            expect(field.text).toBe("ab");
        }
        finally { prompter.close(); }
    });

    it("edits an opted-in field at its caret, restores its saved value, and repaints only that row", async () => {
        const tty = terminal();
        const screen = new TerminalScreen(60, 24);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        const field = { text: "한😀끝", edit: true, savedText: "한😀끝" };
        try {
            const pending = prompter.select("Card", [{ value: "name", label: "Name", input: field }, { value: "back", label: "Back" }], {
                cancelValue: "back", tabs: { active: "name", items: [{ value: "name", label: "Card" }, { value: "back", label: "Other" }] },
            });
            const start = tty.screen().length;
            await press(tty.input, ["\u001b[D", "\u001b[3~", "\u001b[H", "A", "\u001b[F", "\u007f"]);
            expect(field.text).toBe("A한");
            const emitted = tty.screen().slice(start);
            expect(emitted).not.toContain("\u001b[J");
            expect(emitted).not.toContain("? Card");
            expect(emitted).not.toContain("Back");
            expect(emitted).toContain("\u001b[2K");
            await press(tty.input, ["\u0015", "수", "정", "\u001b[D", "X"]);
            expect(field.text).toBe("수X정");
            await press(tty.input, ["\u001b"]);
            expect(field.text).toBe("한😀끝");
            expect(screen.visible().join("\n")).toMatch(/[❯>] Name/);
            await press(tty.input, ["\u001b"]);
            expect(await pending).toBe("back");
        }
        finally { prompter.close(); }
    });

    it("keeps the editable caret visible at both ends of a long wide field", async () => {
        vi.stubEnv("CONCOS_UNICODE", "1");
        const tty = terminal();
        tty.output.columns = 32;
        const screen = new TerminalScreen(32, 24);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        const field = { text: "가".repeat(40) + "끝", edit: true };
        try {
            const pending = prompter.select("Card", [{ value: "role", label: "Role", input: field }]);
            expect(screen.visible()[1]).toMatch(/…가+끝$/);
            expect(screen.cursor()).toEqual({ row: 1, column: displayWidth(screen.visible()[1]), visible: true });
            await press(tty.input, ["\u001b[H"]);
            expect(screen.visible()[1]).toMatch(/Role\s+가+…$/);
            expect(screen.cursor()).toEqual({ row: 1, column: displayWidth(screen.visible()[1].split("가")[0]), visible: true });
            await press(tty.input, ["\u001b[3~", "\u001b[F", "\u007f", "\r"]);
            expect(field.text).toBe("가".repeat(39));
            expect(await pending).toBe("role");
        }
        finally { prompter.close(); vi.unstubAllEnvs(); }
    });

    it.each([false, true])("keeps the real input cursor in its field across redraws, wrapped content and refresh (edit=%s)", async (edit) => {
        vi.useFakeTimers();
        vi.stubEnv("CONCOS_REDUCED_MOTION", "0");
        vi.stubEnv("TERM", "xterm");
        const tty = terminal();
        Object.assign(tty.output, { columns: 54, rows: 20 });
        const screen = new TerminalScreen(54, 20);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        prompter.transient = true;
        const field = { text: "한😀끝", edit, cursor: 2 };
        let detail = "가".repeat(60);
        let frame = 0;
        const items = () => [
            { separator: true as const, lines: () => [detail] },
            { value: "send", label: "Send" },
            { value: "search", label: "Search messages", input: field },
            { value: "back", label: "Back" },
        ];
        const assertCursor = () => {
            const row = screen.visible().findIndex((line) => /[❯>] Search messages/.test(line));
            const prefix = screen.visible()[row].split("한")[0];
            const before = edit ? [...field.text].slice(0, field.cursor).join("") : field.text;
            expect(screen.cursor()).toEqual({ row, column: displayWidth(prefix + before), visible: true });
        };
        try {
            const pending = prompter.select("Card", items(), {
                defaultValue: "search", banner: [[{ text: "Status" }]], preface: ["First\nSecond"],
                refresh: { intervalMs: 200, load: () => ({ question: "Card", items: items() }) },
                animation: { intervalMs: 40, frame: () => ({ question: `Card frame ${frame++}` }) },
            });
            assertCursor();
            tty.input.write("X");
            assertCursor();
            if(edit == true) {
                const start = tty.screen().length;
                tty.input.write("\u001b[D");
                assertCursor();
                expect(tty.screen().slice(start)).not.toContain("\u001b[J");
                expect(tty.screen().slice(start)).not.toContain("Search messages");
            }
            detail += "가".repeat(20);
            await vi.advanceTimersByTimeAsync(400);
            assertCursor();
            tty.input.write("\u001b[A");
            expect(screen.cursor().visible).toBe(false);
            tty.input.write("\u001b[B");
            assertCursor();
            tty.input.write("\r");
            expect(await pending).toBe("search");
            expect(screen.cursor()).toEqual({ row: 0, column: 0, visible: true });
            expect(screen.visible().join("\n").trim()).toBe("");
        }
        finally { prompter.close(); vi.useRealTimers(); vi.unstubAllEnvs(); }
    });

    it.each(["\u001bOQ", "\u001b[12~", "\u001b[1;1Q", "\u0012"])("runs a selected-row shortcut for %j without treating it as input", async (key) => {
        const tty = terminal();
        tty.output.columns = 54;
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select<string>("Room", [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], {
                defaultValue: "b", shortcuts: [{ keys: [key], hint: "F2 name · Ctrl+R role", value: (selected) => `edit:${selected}` }],
            });
            expect(tty.screen()).toContain("F2 name · Ctrl+R role");
            await press(tty.input, [key]);
            expect(await pending).toBe("edit:b");
            expect(tty.raw).toEqual([true, false]);
        }
        finally { prompter.close(); }
    });

    it("colors the answer Enter gives, and a warning after a row's hint, on a color terminal", async () => {
        vi.stubEnv("NO_COLOR", undefined);
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const confirmed = prompter.askYesNo("Register these settings?", true);
            await press(tty.input, ["\r"]);
            expect(await confirmed).toBe(true);
            // Y in bold accent color between dim parentheses
            expect(tty.screen()).toContain("\u001b[2m(\u001b[22m\u001b[1m\u001b[36mY\u001b[39m\u001b[22m\u001b[2m/n)\u001b[22m");
            const picked = prompter.select("Clients", [
                { value: "claude", label: "Claude Code", hint: "MCP registered", hintStatus: "success", hintWarning: "Update available" },
            ]);
            await press(tty.input, ["\r"]);
            expect(await picked).toBe("claude");
            expect(tty.screen()).toContain("\u001b[33m · Update available\u001b[39m");
        }
        finally { prompter.close(); vi.unstubAllEnvs(); }
    });

    it("draws banner lines under the question, styled on a color terminal and as plain text off one", async () => {
        vi.stubEnv("NO_COLOR", undefined);
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const picked = prompter.select("Room", [{ value: "a", label: "Agent" }], {
                banner: [[{ text: "██", paint: prompter.paint.success }, { text: "  2 working" }], [{ text: "__  last 30m" }]],
            });
            await press(tty.input, ["\r"]);
            expect(await picked).toBe("a");
            expect(tty.screen()).toContain("\u001b[32m██\u001b[39m  2 working");
            expect(tty.screen()).toContain("__  last 30m");
        }
        finally { prompter.close(); vi.unstubAllEnvs(); }

        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => { text += chunk.toString(); });
        const lines = new Prompter(Readable.from(["1\n"]), output);
        try {
            expect(await lines.select("Room", [{ value: "a", label: "Agent" }], { banner: [[{ text: "##" }, { text: "  2 working" }], [{ text: "__  last 30m" }]] })).toBe("a");
        }
        finally { lines.close(); }
        expect(text).toContain("? Room\n  ##  2 working\n  __  last 30m\n");
    });

    it("keeps reduced-motion frames static", async () => {
        vi.useFakeTimers();
        vi.stubEnv("CONCOS_REDUCED_MOTION", "1");
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        const frame = vi.fn(() => ({}));
        try {
            const pending = prompter.select("Room", [{ value: "a", label: "Agent" }], { animation: { intervalMs: 40, frame } });
            await vi.advanceTimersByTimeAsync(400);
            expect(frame).toHaveBeenCalledTimes(1);
            tty.input.write("\r");
            expect(await pending).toBe("a");
        }
        finally { prompter.close(); vi.useRealTimers(); vi.unstubAllEnvs(); }
    });

    it("moves with arrow keys, skips separators and restores the terminal", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select("제품", [{ value: "codex", label: "Codex CLI" }, { separator: true }, { value: "claude", label: "Claude Code" }]);
            await press(tty.input, ["\u001b[B", "\r"]);
            expect(await pending).toBe("claude");
            expect(tty.raw).toEqual([true, false]);
        }
        finally { prompter.close(); }
        expect(tty.screen()).toContain("\u001b[?25h");
        expect(tty.input.listenerCount("data")).toBe(0);
    });

    it("edits Korean text and lets Esc leave a field without an answer", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const text = prompter.ask("대합실");
            await press(tty.input, ["팀", "대", "합", "실", "\r"]);
            expect(await text).toBe("팀대합실");
            expect(displayWidth("팀대합실")).toBe(8);
            const cancelled = expect(prompter.ask("대합실")).rejects.toBeInstanceOf(PromptBackError);
            await press(tty.input, ["입력", "\u001b"]);
            await cancelled;
            expect(tty.raw.at(-1)).toBe(false);
        }
        finally { prompter.close(); }
    });

    it("prefills editable text with the cursor at the end, including wide characters", async () => {
        const tty = terminal();
        const screen = new TerminalScreen(60, 24);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        prompter.transient = true;
        try {
            const edited = prompter.ask("Name", { initialValue: "한😀끝" });
            expect(screen.visible().join("\n")).toContain("Name 한😀끝");
            expect(screen.visible().join("\n")).not.toContain("(한😀끝)");
            await press(tty.input, ["\u007f", "!", "\u001b[H", ">", "\u001b[F", "\r"]);
            expect(await edited).toBe(">한😀!");
            expect(screen.visible().join("\n").trim()).toBe("");
            expect(tty.raw).toEqual([true, false]);

            const kept = prompter.ask("Role", { initialValue: "API owner" });
            await press(tty.input, ["\r"]);
            expect(await kept).toBe("API owner");

            const cleared = prompter.ask("Role", { initialValue: "API owner" });
            await press(tty.input, ["\u0015", "\r"]);
            expect(await cleared).toBe("");

            const cancelled = expect(prompter.ask("Role", { initialValue: "API owner" })).rejects.toBeInstanceOf(PromptBackError);
            await press(tty.input, ["x", "\u001b"]);
            await cancelled;
            expect(tty.raw.at(-1)).toBe(false);
            expect(screen.visible().join("\n").trim()).toBe("");
        }
        finally { prompter.close(); }
        expect(tty.screen()).toContain("\u001b[?25h");
    });

    it("moves an editor cursor without repainting and appends only the new character", async () => {
        const tty = terminal();
        tty.output.columns = 24;
        const prompter = new Prompter(tty.input, tty.output);
        prompter.transient = true;
        const original = "Alpha한국0123456789".repeat(3);
        try {
            const pending = prompter.ask("Name", { initialValue: original });
            for(const key of ["\u001b[D", "\u001b[C", "\u001b[H", "\u001b[F"]) {
                const start = tty.screen().length;
                await press(tty.input, [key]);
                const emitted = tty.screen().slice(start);
                expect(emitted).not.toContain("\u001b[J");
                expect(emitted).not.toContain("Alpha");
                expect(Buffer.byteLength(emitted)).toBeLessThanOrEqual(16);
            }
            const start = tty.screen().length;
            await press(tty.input, ["x"]);
            expect(tty.screen().slice(start)).toBe("x");
            await press(tty.input, ["\u001b[D"]);
            const beforeEdit = tty.screen().length;
            await press(tty.input, ["가"]);
            expect(tty.screen().slice(beforeEdit)).not.toContain("Name");
            await press(tty.input, ["\r"]);
            expect(await pending).toBe(`${original}가x`);
        }
        finally { prompter.close(); }
    });

    it("edits around wide-character wrap gaps without touching the prompt or preceding line", async () => {
        const tty = terminal();
        tty.output.columns = 10;
        const screen = new TerminalScreen(10, 12);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        prompter.transient = true;
        try {
            prompter.write("Keep\n");
            const pending = prompter.ask("N", { initialValue: "abcde가끝" });
            expect(screen.visible().slice(0, 3)).toEqual(["Keep", "? N abcde", "가끝"]);
            expect(screen.cursor()).toEqual({ row: 2, column: 4, visible: true });
            await press(tty.input, ["\u001b[D", "\u001b[D"]);
            expect(screen.cursor()).toEqual({ row: 2, column: 0, visible: true });
            await press(tty.input, ["x"]);
            expect(screen.visible().slice(0, 3)).toEqual(["Keep", "? N abcdex", "가끝"]);
            await press(tty.input, ["\u007f", "\u001b[3~"]);
            expect(screen.visible().slice(0, 3)).toEqual(["Keep", "? N abcde", "끝"]);
            await press(tty.input, ["\u001b[F", "\u001b[D", "나", "\r"]);
            expect(await pending).toBe("abcde나끝");
            expect(screen.visible().join("\n").trim()).toBe("Keep");
        }
        finally { prompter.close(); }
    });

    it("edits a secret buffer without writing cursor or text updates", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        prompter.transient = true;
        try {
            const pending = prompter.askSecret("Secret");
            const start = tty.screen().length;
            await press(tty.input, ["비", "밀", "\u001b[D", "\u001b[3~", "\u001b[H", "A", "\u001b[F", "\u007f", "\u0015", "정", "답"]);
            expect(tty.screen().slice(start)).toBe("");
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("정답");
            expect(tty.raw).toEqual([true, false]);
        }
        finally { prompter.close(); }
    });

    it("preserves Enter defaults for existing callers and prefilled values in line mode", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const answer = prompter.ask("Name", "Original");
            await press(tty.input, ["New", "\r"]);
            expect(await answer).toBe("New");
            const kept = prompter.ask("Name", "Original");
            await press(tty.input, ["\r"]);
            expect(await kept).toBe("Original");
        }
        finally { prompter.close(); }

        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => { text += chunk.toString(); });
        const lines = new Prompter(Readable.from(["\nNew\nESC\n"]), output);
        try {
            expect(await lines.ask("Name", { initialValue: "Original" })).toBe("Original");
            expect(await lines.ask("Name", { initialValue: "Original" })).toBe("New");
            await expect(lines.ask("Name", { initialValue: "Original" })).rejects.toBeInstanceOf(PromptBackError);
            expect(text).toContain("? Name (Original)");
        }
        finally { lines.close(); }
    });

    it.each([33, 35, 193])("erases a prefilled field of %i characters without erasing the preceding line", async (length) => {
        const tty = terminal();
        tty.output.columns = 40;
        const screen = new TerminalScreen(40, 24);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        prompter.transient = true;
        try {
            prompter.write("Keep this line\n");
            const value = "x".repeat(length);
            const edited = prompter.ask("Role", { initialValue: value });
            await press(tty.input, ["\r"]);
            expect(await edited).toBe(value);
            expect(screen.visible().join("\n").trim()).toBe("Keep this line");
        }
        finally { prompter.close(); }
    });

    it("treats Ctrl+C and EOF as leaving and resets raw mode", async () => {
        for(const closeInput of [false, true]) {
            const tty = terminal();
            const prompter = new Prompter(tty.input, tty.output);
            try {
                const cancelled = expect(prompter.select("선택", [{ value: "quit", label: "종료" }])).rejects.toBeInstanceOf(PromptClosedError);
                if(closeInput) tty.input.end();
                else await press(tty.input, ["\u0003"]);
                await cancelled;
                expect(tty.raw.at(-1)).toBe(false);
            }
            finally { prompter.close(); }
        }
    });

    it("redraws a live list when its rows change and keeps the cursor on the same value", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        let rows = [{ value: "b", label: "Beta" }, { value: "back", label: "Back" }];
        try {
            const pending = prompter.select("Room", rows, {
                defaultValue: "b",
                refresh: { intervalMs: 10, load: () => ({ question: "Room", items: rows }) },
            });
            rows = [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "back", label: "Back" }];
            await new Promise((resolve) => setTimeout(resolve, 60));
            expect(tty.screen()).toContain("Alpha");
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("b");
            const drawsAfterPick = tty.screen().length;
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(tty.screen().length).toBe(drawsAfterPick);
        }
        finally { prompter.close(); }
    });

    it("windows a list taller than the terminal around the active row, drawn lines included", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 10 });
        const prompter = new Prompter(tty.input, tty.output);
        const rows = Array.from({ length: 8 }, (_, index) => ({
            value: `agent${index}`,
            label: `Agent ${index}`,
            lines: () => [[{ text: `Agent ${index}` }], [{ text: `  Task  work ${index}` }], [{ text: `  Next  step ${index}` }]],
        }));
        try {
            const pending = prompter.select("Room", rows);
            const lastFrame = () => tty.screen().slice(tty.screen().lastIndexOf("\u001b[J") + 3).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
            expect(lastFrame()).toMatch(/↑↓ move · Enter select · Esc back · PgUp\/PgDn scroll · ↓\d+/);
            expect(lastFrame()).not.toContain("above");
            await press(tty.input, Array.from({ length: 7 }, () => "\u001b[B"));
            const frame = lastFrame();
            expect(frame.split("\n").length).toBeLessThanOrEqual(9);
            expect(frame).toMatch(/[❯>] Agent 7/);
            expect(frame).toContain("Next  step 7");
            expect(frame).not.toContain("Agent 0");
            expect(frame).toMatch(/↑↓ move · Enter select · Esc back · PgUp\/PgDn scroll · ↑\d+/);
            expect(frame).not.toContain("below");
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("agent7");
        }
        finally { prompter.close(); }
    });

    it("keeps a list inside a terminal shorter than it, so redrawing leaves no copy above", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 4 });
        const screen = new TerminalScreen(60, 4);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select("concos · Shared waiting room", [
                { value: "setup", label: "Register MCP", hint: "Set up once for this user" },
                { value: "status", label: "Enter concos", hint: "Agents · Messages" },
                { value: "say", label: "Send a message" },
                { separator: true },
                { value: "quit", label: "Quit" },
            ]);
            await press(tty.input, ["\u001b[B", "\u001b[A"]);
            expect(screen.transcript().filter((line) => line.includes("Shared waiting room"))).toHaveLength(1);
            expect(screen.visible().join("\n")).toMatch(/[❯>] Register MCP/);
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("setup");
        }
        finally { prompter.close(); }
    });

    it.each([54, 80, 100])("reads text after the menu without activating an offscreen choice at %s columns", async (columns) => {
        const tty = terminal();
        Object.assign(tty.output, { columns, rows: 16 });
        const screen = new TerminalScreen(columns, 16);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        let completed = false;
        try {
            const pending = prompter.select("Agent detail", [
                { separator: true, lines: () => ["working  Server", "Codex · online"] },
                { separator: true, label: "Card" },
                { value: "name", label: "Name" }, { value: "role", label: "Role" },
                { value: "back", label: "Back" },
                { separator: true, lines: () => Array.from({ length: 35 }, (_, index) => `Summary line ${index}`) },
            ]).then((value) => { completed = true; return value; });
            expect(screen.visible().join("\n")).toMatch(/[❯>] Name/);
            expect(screen.visible().join("\n")).toContain("Summary line 0");
            await press(tty.input, ["\u001b[B", "\u001b[B"]);
            await press(tty.input, Array.from({ length: 6 }, () => "\u001b[6~"));
            expect(screen.visible().join("\n")).toContain("Summary line 34");
            expect(screen.visible().join("\n")).toContain("Enter returns to menu");
            await press(tty.input, ["\r"]);
            expect(completed).toBe(false);
            expect(screen.visible().join("\n")).toMatch(/[❯>] Name/);
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("name");
            expect(tty.raw.at(-1)).toBe(false);
        }
        finally { prompter.close(); }
    });

    it("selects a visible menu choice immediately after paging back from read-only text", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 12 });
        const screen = new TerminalScreen(60, 12);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select("Card", [
                { value: "name", label: "Name" }, { value: "back", label: "Back" },
                { separator: true, lines: () => Array.from({ length: 30 }, (_, index) => `Detail ${index}`) },
            ]);
            await press(tty.input, Array.from({ length: 5 }, () => "\u001b[6~"));
            expect(screen.visible().join("\n")).toContain("Enter returns to menu");
            await press(tty.input, Array.from({ length: 5 }, () => "\u001b[5~"));
            expect(screen.visible().join("\n")).toMatch(/[>❯] Name/);
            expect(screen.visible().join("\n")).not.toContain("Enter returns to menu");
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("name");
        }
        finally { prompter.close(); }
    });

    it("prints read-only list text in line mode without adding a numbered choice", async () => {
        const output = new PassThrough();
        let written = "";
        output.on("data", (chunk) => { written += chunk.toString(); });
        const prompter = new Prompter(Readable.from(["2\n"]), output);
        try {
            expect(await prompter.select("Card", [
                { separator: true, lines: () => ["\u001b[1mServer\u001b[0m"] },
                { value: "name", label: "Name" }, { value: "back", label: "Back" },
                { separator: true, lines: () => ["Summary  full detail"] },
            ])).toBe("back");
            expect(written).toMatch(/Card\nServer\n\s+1\) Name\n\s+2\) Back\nSummary/);
            expect(written).not.toContain("\u001b");
            expect(written).not.toContain("3)");
        }
        finally { prompter.close(); }
    });

    it("pages only the preface, keeps the question and actions fixed, and erases the detail on Esc", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 12 });
        const screen = new TerminalScreen(60, 12);
        screen.write("$ concos\n");
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        const rowOf = (text: string) => screen.visible().findIndex((line) => line.includes(text));
        try {
            const pending = prompter.select("Message detail", [
                { value: "reply", label: "Reply" }, { value: "back", label: "Back" },
            ], { cancelValue: "back", preface: Array.from({ length: 40 }, (_, index) => `Detail line ${index}`) });
            const positions = [rowOf("Message detail"), rowOf("Reply"), rowOf("Back"), rowOf("Enter")];
            expect(screen.visible().join("\n")).toContain("Detail line 0");
            await press(tty.input, ["\u001b[B", "\u001b[6~"]);
            expect([rowOf("Message detail"), rowOf("Reply"), rowOf("Back"), rowOf("Enter")]).toEqual(positions);
            expect(screen.visible().join("\n")).not.toContain("Detail line 0\n");
            expect(screen.visible().join("\n")).toMatch(/[❯>] Back/);
            await press(tty.input, ["\u001b[A", "\u001b[F"]);
            expect(screen.visible().join("\n")).toContain("Detail line 39");
            expect(screen.visible().join("\n")).toMatch(/[❯>] Reply/);
            await press(tty.input, ["\u001b[H"]);
            expect(screen.visible().join("\n")).toContain("Detail line 0\n");
            await press(tty.input, ["\u001b"]);
            expect(await pending).toBe("back");
            expect(screen.transcript().join("\n")).toContain("$ concos");
            expect(screen.transcript().join("\n")).not.toMatch(/Message detail|Detail line|Reply|Back/);
            expect(tty.raw).toEqual([true, false]);
        }
        finally { prompter.close(); }
    });

    it("wraps styled wide preface text and embedded newlines without overflowing the screen", async () => {
        vi.stubEnv("NO_COLOR", undefined);
        const tty = terminal();
        Object.assign(tty.output, { columns: 18, rows: 8 });
        const screen = new TerminalScreen(18, 8);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        const frame = () => tty.screen().slice(tty.screen().lastIndexOf("\u001b[J") + 3);
        try {
            const pending = prompter.select("Detail", [{ value: "back", label: "Back" }], {
                preface: ["\u001b[35m가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허\r\n새 줄\n\n끝\u001b[39m"],
            });
            expect(screen.visible()[1]).toBe("가나다라마바사아");
            expect(frame().split("\n")[1]).toBe("\u001b[35m가나다라마바사아\u001b[0m");
            const actionRow = screen.visible().findIndex((line) => /[❯>] Back/.test(line));
            await press(tty.input, ["\u001b[6~"]);
            expect(frame().split("\n")[1]).toMatch(/^\u001b\[35m/);
            expect(screen.visible().join("\n")).toContain("새 줄\n\n끝");
            expect(screen.visible().findIndex((line) => /[❯>] Back/.test(line))).toBe(actionRow);
            for(const line of frame().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n")) {
                expect(displayWidth(line)).toBeLessThanOrEqual(17);
            }
            expect(screen.transcript()).toHaveLength(8);
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("back");
        }
        finally { prompter.close(); vi.unstubAllEnvs(); }
    });

    it("keeps detail text readable beside overflowing message choices and pages it independently", async () => {
        for(const height of [24, 10, 6]) {
            const tty = terminal();
            Object.assign(tty.output, { rows: height });
            const screen = new TerminalScreen(60, height);
            tty.output.on("data", (chunk) => screen.write(chunk.toString()));
            const prompter = new Prompter(tty.input, tty.output);
            const rows = Array.from({ length: 8 }, (_, index) => ({
                value: `message${index}`, label: `Message ${index}`,
                lines: () => [[{ text: `Message ${index}` }], ...Array.from({ length: 10 }, (_, line) => [{ text: `  Delivery ${index}/${line}` }])],
            }));
            try {
                const pending = prompter.select("Agent detail", rows, { preface: Array.from({ length: 18 }, (_, index) => `Agent summary line ${index}`) });
                expect(screen.visible().filter((line) => line.startsWith("Agent summary line")).length).toBeGreaterThanOrEqual(Math.min(4, height - 4));
                await press(tty.input, Array.from({ length: 7 }, () => "\u001b[B"));
                const choiceStart = screen.visible().findIndex((line) => /[❯>] Message 7/.test(line));
                expect(choiceStart).toBeGreaterThan(1);
                const choiceRows = screen.visible().slice(choiceStart, height - 2);
                await press(tty.input, ["\u001b[6~", "\u001b[F"]);
                expect(screen.visible().join("\n")).toContain("Agent summary line 17");
                expect(screen.visible().slice(choiceStart, height - 2)).toEqual(choiceRows);
                expect(screen.transcript()).toHaveLength(height);
                await press(tty.input, ["\r"]);
                expect(await pending).toBe("message7");
            }
            finally { prompter.close(); }
        }
    });

    it("keeps Enter, Esc and tab switching in narrow footers before scroll counts", async () => {
        for(const columns of [54, 28, 16]) {
            for(const withTabs of [false, true]) {
                const tty = terminal();
                Object.assign(tty.output, { columns: columns, rows: 10 });
                const screen = new TerminalScreen(columns, 10);
                tty.output.on("data", (chunk) => screen.write(chunk.toString()));
                const prompter = new Prompter(tty.input, tty.output);
                try {
                    let tabs;
                    if(withTabs == true) {
                        tabs = { active: "agents", items: [{ value: "agents", label: "Agents" }, { value: "messages", label: "Messages" }] };
                    }
                    const pending = prompter.select("Room", Array.from({ length: 20 }, (_, index) => ({ value: `agent${index}`, label: `Agent ${index}` })), { tabs: tabs });
                    const footer = screen.visible().find((line) => line.includes("Enter"))!;
                    expect(footer).toContain("Esc");
                    expect(footer).not.toMatch(/…|\.\.\./);
                    expect(displayWidth(footer)).toBeLessThanOrEqual(columns - 1);
                    if(withTabs == true) {
                        expect(footer).toMatch(/←→|Tab/);
                    }
                    await press(tty.input, ["\r"]);
                    expect(await pending).toBe("agent0");
                }
                finally { prompter.close(); }
            }
        }
    });

    it("prints unstyled preface text before line-mode choices and still accepts number, key and label", async () => {
        for(const answer of ["2", "back", "Go back"]) {
            const output = new PassThrough();
            let written = "";
            output.on("data", (chunk) => { written += chunk.toString(); });
            const prompter = new Prompter(Readable.from([`${answer}\n`]), output);
            try {
                expect(await prompter.select("Detail", [{ value: "reply", label: "Reply" }, { value: "exit", key: "back", label: "Go back" }], {
                    preface: ["\u001b[35m상세\n두 줄\u001b[39m"],
                })).toBe("exit");
                expect(written).toMatch(/Detail\n상세\n두 줄\n\s+1\) Reply/);
                expect(written).not.toContain("\u001b");
            }
            finally { prompter.close(); }
        }
    });

    it("honors NO_COLOR for a preface supplied with ANSI styles", async () => {
        vi.stubEnv("NO_COLOR", "1");
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select("Detail", [{ value: "back", label: "Back" }], { preface: ["\u001b[35mColored detail\u001b[39m"] });
            expect(tty.screen()).toContain("Colored detail");
            expect(tty.screen()).not.toMatch(/\u001b\[[0-9;]*m/);
            await press(tty.input, ["\r"]);
            await pending;
        }
        finally { prompter.close(); vi.unstubAllEnvs(); }
    });

    it("erases back to a mark, wrapped lines included, and leaves rows above the window in the scrollback", async () => {
        const tty = terminal();
        Object.assign(tty.output, { columns: 40, rows: 10 });
        const screen = new TerminalScreen(40, 10);
        screen.write("$ concos\n");
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const top = prompter.mark();
            // 100 columns: three rows at 40
            prompter.write(`${"wide ".repeat(20)}\nshort\n`);
            prompter.eraseTo(top);
            expect(screen.visible().filter((line) => line != "")).toEqual(["$ concos"]);

            prompter.write(Array.from({ length: 25 }, (_, index) => `preview ${index}\n`).join(""));
            prompter.eraseTo(top);
            prompter.write("list\n");
            expect(screen.visible()[0]).toBe("list");
            expect(screen.transcript()).toContain("preview 0");
        }
        finally { prompter.close(); }
    });

    it("redraws a list to fit when the terminal is resized", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 20 });
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select("Room", Array.from({ length: 6 }, (_, index) => ({ value: `a${index}`, label: `Agent ${index}` })));
            Object.assign(tty.output, { rows: 5 });
            tty.output.emit("resize");
            const lastFrame = tty.screen().slice(tty.screen().lastIndexOf("\u001b[J") + 3).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
            expect(lastFrame.split("\n").length).toBeLessThanOrEqual(4);
            expect(lastFrame).toMatch(/[❯>] Agent 0/);
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("a0");
            expect(tty.output.listenerCount("resize")).toBe(0);
        }
        finally { prompter.close(); }
    });

    it("reads every line of an oversized message and keeps its page when the list refreshes", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 10 });
        const prompter = new Prompter(tty.input, tty.output);
        const message = { value: "message", label: "Message", lines: () => [
            [{ text: "Message title" }],
            ...Array.from({ length: 40 }, (_, index) => [{ text: `Body line ${index}` }]),
        ] };
        let incoming = false;
        const items = () => incoming ? [{ value: "new", label: "New arrival" }, message] : [message];
        const frame = () => tty.screen().slice(tty.screen().lastIndexOf("\u001b[J") + 3).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
        const bodyLines = () => [...frame().matchAll(/Body line (\d+)/g)].map((match) => Number(match[1]));
        const seen = new Set<number>();
        try {
            const pending = prompter.select("Messages", items(), { refresh: { intervalMs: 10, load: () => ({ question: "Messages", items: items() }) } });
            expect(frame()).toContain("Message title");
            for(const line of bodyLines()) seen.add(line);
            await press(tty.input, ["\u001b[B", "\u001b[6~"]);
            const before = bodyLines();
            for(const line of before) seen.add(line);
            incoming = true;
            await new Promise((resolve) => setTimeout(resolve, 35));
            expect(bodyLines()).toEqual(before);
            for(let page = 0; page < 8; page += 1) {
                await press(tty.input, ["\u001b[6~"]);
                for(const line of bodyLines()) seen.add(line);
            }
            expect(seen.size).toBe(40);
            expect(frame()).toContain("Body line 39");
            expect(frame().split("\n").length).toBeLessThanOrEqual(9);
            await press(tty.input, Array.from({ length: 8 }, () => "\u001b[5~"));
            expect(frame()).toContain("Message title");
            await press(tty.input, ["\r"]);
            expect(await pending).toBe("message");
        }
        finally { prompter.close(); }
    });

    it("keeps the selected card visible when its body shrinks after paging and rows above change", async () => {
        vi.useFakeTimers();
        const tty = terminal();
        Object.assign(tty.output, { rows: 10 });
        const screen = new TerminalScreen(60, 10);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        let changed = false;
        const rows = () => Array.from({ length: 8 }, (_, index) => {
            let count = 3;
            if(index == 2) {
                count = 26;
                if(changed == true) {
                    count = 2;
                }
            }
            if(index == 0 && changed == true) {
                count = 5;
            }
            return { value: `card${index}`, label: `Card ${index}`, lines: () => Array.from({ length: count }, (_, line) => [{ text: line == 0 ? `Card ${index}` : `  Task ${index}/${line}` }]) };
        });
        try {
            const picked = prompter.select("Room", rows(), { defaultValue: "card2", refresh: { intervalMs: 20, load: () => ({ question: "Room", items: rows() }) } });
            tty.input.write("\u001b[6~");
            tty.input.write("\u001b[6~");
            changed = true;
            await vi.advanceTimersByTimeAsync(40);
            expect(screen.visible().join("\n")).toMatch(/[❯>] Card 2/);
            tty.input.write("\r");
            expect(await picked).toBe("card2");
        }
        finally { prompter.close(); vi.useRealTimers(); }
    });

    it("anchors the selected card when rows above grow during animation before the next refresh", async () => {
        vi.useFakeTimers();
        vi.stubEnv("CONCOS_REDUCED_MOTION", "0");
        vi.stubEnv("TERM", "xterm");
        const tty = terminal();
        Object.assign(tty.output, { rows: 10 });
        const screen = new TerminalScreen(60, 10);
        tty.output.on("data", (chunk) => screen.write(chunk.toString()));
        const prompter = new Prompter(tty.input, tty.output);
        let changed = false;
        const rows = Array.from({ length: 8 }, (_, index) => ({
            value: `card${index}`, label: `Card ${index}`,
            lines: () => {
                let count = 3;
                if(index < 4 && changed == true) {
                    count = 7;
                }
                return Array.from({ length: count }, (_, line) => [{ text: line == 0 ? `Card ${index}` : `  Task ${index}/${line}` }]);
            },
        }));
        const load = vi.fn(() => ({ question: "Room", items: rows }));
        try {
            const picked = prompter.select("Room", rows, {
                defaultValue: "card4", refresh: { intervalMs: 1000, load },
                animation: { intervalMs: 40, frame: () => ({}) },
            });
            const before = screen.visible().findIndex((line) => /[❯>] Card 4/.test(line));
            changed = true;
            await vi.advanceTimersByTimeAsync(120);
            expect(load).not.toHaveBeenCalled();
            expect(screen.visible().findIndex((line) => /[❯>] Card 4/.test(line))).toBe(before);
            tty.input.write("\r");
            expect(await picked).toBe("card4");
        }
        finally { prompter.close(); vi.useRealTimers(); vi.unstubAllEnvs(); }
    });

    it("selects the visible message when a page starts on the blank space between messages", async () => {
        const tty = terminal();
        Object.assign(tty.output, { rows: 10 });
        const prompter = new Prompter(tty.input, tty.output);
        const first = { value: "first", label: "First", lines: () => [
            ...Array.from({ length: 12 }, (_, index) => [{ text: `First message ${index}` }]), [],
        ] };
        const second = { value: "second", label: "Second", lines: () => Array.from({ length: 12 }, (_, index) => [{ text: `Second message ${index}` }]) };
        try {
            const pending = prompter.select("Messages", [first, second]);
            await press(tty.input, ["\u001b[6~", "\u001b[6~", "\r"]);
            expect(await pending).toBe("second");
        }
        finally { prompter.close(); }
    });

    it("ends a line cut at the terminal width with an ellipsis", async () => {
        const tty = terminal();
        const prompter = new Prompter(tty.input, tty.output);
        try {
            const pending = prompter.select("Room", [{ value: "a", label: "Agent", hint: "x".repeat(200) }]);
            const frame = tty.screen().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
            const row = frame.split("\n").find((line) => line.includes("Agent"))!;
            expect(displayWidth(row)).toBeLessThanOrEqual(59);
            expect(row).toMatch(/x(…|\.\.\.)$/);
            await press(tty.input, ["\r"]);
            await pending;
        }
        finally { prompter.close(); }
    });

    it("draws a tab bar and finishes with the neighbouring tab on Tab, Shift+Tab, ← and →", async () => {
        const tabs = {
            active: "tab:b",
            items: [{ value: "tab:a", label: "Alpha 1" }, { value: "tab:b", label: "Beta 2" }, { value: "tab:c", label: "Gamma 3" }],
        };
        const rows = [{ value: "row", label: "Row" }];
        for(const [key, expected] of [["\t", "tab:c"], ["\u001b[C", "tab:c"], ["\u001b[Z", "tab:a"], ["\u001b[D", "tab:a"]]) {
            const tty = terminal();
            const prompter = new Prompter(tty.input, tty.output);
            try {
                const pending = prompter.select("Room", rows, { tabs: tabs });
                const frame = tty.screen().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
                expect(frame).toContain(" Alpha 1   [Beta 2]   Gamma 3");
                expect(frame).toContain("←→ tab");
                await press(tty.input, [key]);
                expect(await pending).toBe(expected);
                expect(tty.raw.at(-1)).toBe(false);
            }
            finally { prompter.close(); }
        }
    });

    it("switches tabs off a terminal when a tab's key or label is typed", async () => {
        const output = new PassThrough();
        let written = "";
        output.on("data", (chunk) => { written += chunk.toString(); });
        const tabs = { active: "tab:a", items: [{ value: "tab:a", label: "Agents 2", key: "agents" }, { value: "tab:m", label: "Messages 5", key: "messages" }] };
        for(const answer of ["messages", "Messages 5"]) {
            const prompter = new Prompter(Readable.from([`${answer}\n`]), output);
            try { expect(await prompter.select("Room", [{ value: "row", label: "Row" }], { tabs: tabs })).toBe("tab:m"); }
            finally { prompter.close(); }
        }
        expect(written).toContain("[Agents 2]  Messages 5");
    });

    it("reads the last piped answer without requiring a newline", async () => {
        const output = new PassThrough();
        output.resume();
        const prompter = new Prompter(Readable.from(["quit"]), output);
        try { expect(await prompter.select("선택", [{ value: "quit", label: "종료" }])).toBe("quit"); }
        finally { prompter.close(); }
    });
});
