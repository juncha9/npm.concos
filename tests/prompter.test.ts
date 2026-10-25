import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { Prompter, PromptBackError, PromptClosedError, displayWidth } from "../src/modules/cli/prompter";
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
            expect(lastFrame()).toMatch(/\d+ lines below · ↑↓ move/);
            expect(lastFrame()).not.toContain("above");
            await press(tty.input, Array.from({ length: 7 }, () => "\u001b[B"));
            const frame = lastFrame();
            expect(frame.split("\n").length).toBeLessThanOrEqual(9);
            expect(frame).toMatch(/[❯>] Agent 7/);
            expect(frame).toContain("Next  step 7");
            expect(frame).not.toContain("Agent 0");
            expect(frame).toMatch(/\d+ lines above · ↑↓ move/);
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
