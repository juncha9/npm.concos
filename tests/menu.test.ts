import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMenu } from "../src/modules/cli/menu";
import type { MenuOptions } from "../src/modules/cli/menu";
import { applySetup, inspectHooks, inspectSetup, inspectWake, planHooks, planSetup } from "../src/modules/cli/setup";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";

let directory: string;
const cli = path.resolve("dist/cli.js");
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-menu-"));
    vi.stubEnv("CONCOS_HOME", path.join(directory, "data"));
    vi.stubEnv("CODEX_HOME", path.join(directory, "user", ".codex"));
});
afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
});

async function menu(answers: string, options: Partial<MenuOptions> = {}): Promise<string> {
    const input = Readable.from([answers]);
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => { written += chunk.toString(); });
    await runMenu({ input, output, home: path.join(directory, "user"), ...options });
    expect(input.listenerCount("data")).toBe(0);
    expect(input.listenerCount("end")).toBe(0);
    return written;
}

async function seedRoom() {
    const database = await openDatabase(path.join(directory, "data"));
    const store = new RoomStore(database);
    const agent = store.join({ room: "dev", displayName: "Server", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
    database.close();
    return agent;
}

describe("registration menu", () => {
    it("selects a supported client directly and writes only after the preview is accepted", async () => {
        const output = await menu("setup\nclaude\ny\nback\nquit\n");
        expect(output.indexOf("Settings to add")).toBeLessThan(output.indexOf("Register these settings?"));
        expect(output).toContain("MCP registered for Claude Code.");
        expect(inspectSetup({ host: "claude", home: path.join(directory, "user") })).toEqual({ registered: true, room: "main" });
        expect(fs.existsSync(path.join(directory, ".codex"))).toBe(false);
    });

    it.each([
        "setup\ncodex\n\nback\nquit\n", // Enter defaults to not writing.
        "setup\ncodex\n", // EOF at confirmation.
        "setup\ncodex\nESC\nback\nquit\n", // Esc at confirmation.
        "setup\nESC\nquit\n", // Esc from the client list.
        "quit", // EOF without a trailing newline.
    ])("cancels safely without creating settings for %j", async (answers) => {
        await menu(answers);
        expect(fs.readdirSync(directory)).toEqual([]);
    });

    it("shows existing registration without displaying secrets and does not add duplicate hooks", async () => {
        const input = { host: "claude", home: path.join(directory, "user") };
        applySetup(planSetup(input));
        const file = path.join(directory, "user", ".claude.json");
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        data.mcpServers.private = { command: "private-server", env: { TOKEN: "hidden-token-value" } };
        fs.writeFileSync(file, JSON.stringify(data));
        const hookFile = path.join(directory, "user", ".claude", "settings.json");
        fs.mkdirSync(path.dirname(hookFile));
        fs.writeFileSync(hookFile, '{"hooks":{"Stop":[{"hooks":[{"command":"legacy-hook"}]}]}}');
        const before = fs.readFileSync(hookFile, "utf8");
        // the client's optional hooks open next; back leaves them untouched
        const output = await menu("claude\nback\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(output).toContain("User-wide registration");
        expect(output).toContain("already has the same registration");
        expect(output).not.toContain("hidden-token-value");
        expect(fs.readFileSync(path.join(directory, "user", ".claude", "settings.json"), "utf8")).toBe(before);
    });

    it("lists all supported clients with registration status without an intermediate field editor", async () => {
        const output = await menu("back\nquit\n", { startWithSetup: true });
        expect(output).toContain("User-wide registration");
        expect(output).toContain("One shared waiting room");
        for(const label of ["Claude Code", "Codex CLI", "Gemini CLI", "Cursor", "Copilot CLI"]) expect(output).toContain(label);
        expect(output).toContain("Not registered");
        expect(output).not.toContain("Preview & register");
        expect(output).not.toContain("hooks");
        expect(output).not.toContain("Project folder");
        expect(output).not.toContain("Scope");
        expect(output).not.toContain("Room name");
    });

    it("writes user settings to the chosen home and leaves project settings alone", async () => {
        const home = path.join(directory, "home");
        const output = await menu("gemini\ny\nback\nquit\n", { home, host: "gemini", startWithSetup: true });
        expect(output).toContain("MCP registered for Gemini CLI.");
        expect(inspectSetup({ host: "gemini", scope: "user", directory, home }).room).toBe("main");
        expect(fs.existsSync(path.join(directory, ".gemini"))).toBe(false);
    });

    it("refreshes registration status and lets another client register from the same list", async () => {
        const output = await menu("setup\nclaude\ny\ncodex\ny\nback\nquit\n");
        for(const host of ["claude", "codex"]) {
            expect(inspectSetup({ host, home: path.join(directory, "user") })).toMatchObject({ registered: true });
        }
        const afterFirstRegistration = output.slice(output.indexOf("MCP registered for Claude Code."));
        expect(afterFirstRegistration).toContain("MCP registered");
        expect(afterFirstRegistration).toMatch(/[✔√] MCP registered/);
        // optional hooks stay off until turned on for the client
        expect(afterFirstRegistration).toContain("MCP registered · Hooks off");
        expect(afterFirstRegistration).toContain("MCP registered for Codex CLI.");
    });
});

describe("room menu", () => {
    it("lists agents one per line, opens an agent's card and returns to the menu", async () => {
        const agent = await seedRoom();
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        store.checkIn(agent.agent_id, {
            cursor: null,
            expectedRevision: null,
            update: { task: "message storage", summary: "Stored messages; retry dedupe remains.", blocker: "needs schema review" },
            checkpoint: "merged the storage layer",
            receivedMessageIds: [],
        });
        database.close();

        const output = await menu("status\nServer\nback\nback\nquit\n");
        expect(output).toContain("Waiting room · 1 blocked");
        expect(output).toContain("[Agents 1]  Messages 0");
        expect(output).toMatch(/1\) blocked +Server \(Codex\) · just now/);
        expect(output).toMatch(/ {10}Blocker  needs schema review/);
        expect(output).toMatch(/ {10}Task     message storage/);
        expect(output).toContain(agent.agent_id);
        expect(output).toContain("Stored messages; retry dedupe remains.");
        expect(output).toContain("merged the storage layer");
        expect(output.lastIndexOf("concos · Shared waiting room")).toBeGreaterThan(output.indexOf("merged the storage layer"));
    });

    it("erases an agent's card on a terminal when going back, so the list returns in its place", async () => {
        const agent = await seedRoom();
        const database = await openDatabase(path.join(directory, "data"));
        new RoomStore(database).checkIn(agent.agent_id, {
            cursor: null, expectedRevision: null, update: { summary: "card summary text" }, checkpoint: null, receivedMessageIds: [],
        });
        database.close();

        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 30 });
        let screen = "";
        output.on("data", (chunk) => { screen += chunk.toString(); });
        const running = runMenu({ input, output, home: path.join(directory, "user") });
        // menu: Enter concos; board: the agent; card: Esc back; board: Esc; menu: Esc quits
        for(const key of ["2", "\r", "\r", "\u001b", "\u001b", "\u001b"]) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            input.write(key);
        }
        await running;

        const afterCard = screen.slice(screen.indexOf("card summary text"));
        const erase = afterCard.search(/\u001b\[\d+A\r\u001b\[J/);
        expect(erase).toBeGreaterThan(0);
        expect(afterCard.slice(erase)).toContain("[Agents 1]");
        expect(screen).not.toMatch(/[✔√] Waiting room/);
    });

    it("switches to the Messages tab by name and opens a whole message from it", async () => {
        const agent = await seedRoom();
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const human = store.ensureHumanParticipant("main", "Reviewer");
        const text = "First line\nSecond line with details\n\n" + "Original message text. ".repeat(60) + "\nLast line of the complete message";
        store.sendMessage(human, { to: agent.agent_id, kind: "question", text, replyTo: null, requestId: null });
        database.close();

        const output = await menu("status\nmessages\n1\nback\nquit\n");
        expect(output).toContain("Server (Codex) (1 unread)");
        expect(output).toContain(" Agents 1  [Messages 1]");
        expect(output).toMatch(/1\) #1 \[QUESTION\] {2}Reviewer (→|->) Server \(Codex\) +just now · Pending 1/);
        const list = output.slice(output.indexOf("[Messages 1]"), output.indexOf("From  Reviewer"));
        expect(list).not.toContain("Last line of the complete message");
        expect(list).toMatch(/Original message text.*(…|\.\.\.)/);
        // the whole-message view, opened with the row's number
        expect(output).toContain("From  Reviewer");
        expect(output).toContain("Awaiting  Server");
        expect(output).toContain("  First line\n  Second line with details");
        expect(output).toContain("Last line of the complete message");
        expect(output.lastIndexOf("concos · Shared waiting room")).toBeGreaterThan(output.indexOf("From  Reviewer"));
    });

    it("switches tabs with Tab on a terminal and shows message text without opening it", async () => {
        const agent = await seedRoom();
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const human = store.ensureHumanParticipant("main", "Reviewer");
        store.sendMessage(human, { to: agent.agent_id, kind: "note", text: "preview text visible in the list", replyTo: null, requestId: null });
        database.close();

        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 30 });
        let screen = "";
        output.on("data", (chunk) => { screen += chunk.toString(); });
        const running = runMenu({ input, output, home: path.join(directory, "user") });
        const frames: string[] = [];
        // menu: Enter concos; board: Tab to Messages, open the message, Esc back to the
        // tab, ← back to Agents; Esc twice leaves
        for(const key of ["2", "\r", "\t", "SNAP", "\r", "\u001b", "SNAP", "\u001b[D", "SNAP", "\u001b", "\u001b"]) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            if(key == "SNAP") {
                frames.push(screen.slice(screen.lastIndexOf("\u001b[J") + 3).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ""));
                continue;
            }
            input.write(key);
        }
        await running;

        expect(frames[0]).toContain("[Messages 1]");
        expect(frames[0]).toContain("Reviewer");
        expect(frames[0]).toContain("preview text visible in the list");
        expect(frames[0]).toContain("←→ tab");
        // Esc after reading the whole message returned to the Messages tab, not the main menu
        expect(frames[1]).toContain("[Messages 1]");
        expect(frames[2]).toContain("[Agents 1]");
        expect(frames[2]).toContain("Server");
        expect(frames[2]).not.toContain("preview text visible in the list");
    });

    it("sends a message from an agent's card without asking for the recipient", async () => {
        const agent = await seedRoom();
        const output = await menu(`status\nServer\nsay\nPlease review this change\n\ny\nback\nquit\n`);
        expect(output).not.toContain("? Recipient");
        expect(output).toContain(`Recipient: Server (Codex) (${agent.agent_id})`);
        const database = await openDatabase(path.join(directory, "data"));
        try {
            expect(database.prepare("SELECT recipient_agent_id, kind FROM message").get()).toMatchObject({ recipient_agent_id: agent.agent_id, kind: "note" });
        }
        finally { database.close(); }
    });

    it("stores a message for the selected participant after confirmation", async () => {
        const agent = await seedRoom();
        // Enter at the topics prompt files the message under none
        const output = await menu(`say\n${agent.agent_id}\n검증 메시지\n\ny\nquit\n`);
        expect(output).toContain("1 recipient(s)");
        const database = await openDatabase(path.join(directory, "data"));
        try {
            expect(database.prepare("SELECT recipient_agent_id, kind, body FROM message").get()).toMatchObject({ recipient_agent_id: agent.agent_id, kind: "note", body: "검증 메시지" });
        }
        finally { database.close(); }
    });

    it("does not store a message when confirmation is declined", async () => {
        const agent = await seedRoom();
        await menu(`say\n${agent.agent_id}\n취소할 메시지\n\n\nquit\n`);
        const database = await openDatabase(path.join(directory, "data"));
        try { expect(database.prepare("SELECT COUNT(*) AS count FROM message").get()).toMatchObject({ count: 0 }); }
        finally { database.close(); }
    });

    it("sends one message to several picked agents under the typed topics, asking again for a mistyped topic", async () => {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const join = (displayName: string) => store.join({ room: "main", displayName, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const first = join("First");
        const second = join("Second");
        join("Third");
        database.close();

        const output = await menu("say\nseveral\nFirst\nSecond\ndone\nreview the board\nboard\nConcos board, concos-ui\ny\nquit\n");
        expect(output).toContain("Recipients · First (Codex), Second (Codex)");
        expect(output).toContain(`topic "board" must be`);
        expect(output).toContain(`Recipient: First (Codex) (${first.agent_id}), Second (Codex) (${second.agent_id})`);
        expect(output).toContain("Topics: concos_board, concos_ui");
        expect(output).toContain("2 recipient(s)");
        const check = await openDatabase(path.join(directory, "data"));
        try {
            expect(check.prepare("SELECT recipient_scope, body FROM message").get()).toMatchObject({ recipient_scope: "group", body: "review the board" });
            const receipts = check.prepare("SELECT agent_id FROM message_receipt ORDER BY agent_id").all().map((row) => row.agent_id);
            expect(receipts).toEqual([first.agent_id, second.agent_id].sort());
            const topics = check.prepare("SELECT topic_key FROM message_topic ORDER BY position").all().map((row) => row.topic_key);
            expect(topics).toEqual(["concos_board", "concos_ui"]);
        }
        finally { check.close(); }
    });

    it("uses English for menu labels, reports and empty-state guidance", async () => {
        const output = await menu("status\nsay\nquit\n");
        expect(output).toContain("Register MCP");
        expect(output).toContain("No agents have joined the shared waiting room yet");
        expect(output).toContain("No agents have joined yet");
        expect(output).not.toMatch(/[가-힣]/);
    });
});

describe("ended sessions on the board", () => {
    async function seedWithEnded() {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const live = store.join({ room: "main", displayName: "Live", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const gone = store.join({ room: "main", displayName: "Gone", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        store.disconnect([gone.agent_id]);
        return { database, store, live, gone };
    }

    it("folds ended sessions behind a toggle and keeps them out of the counts", async () => {
        const { database } = await seedWithEnded();
        database.close();
        const output = await menu("status\nended\nback\nquit\n");
        const firstBoard = output.slice(output.indexOf("? Waiting room"), output.indexOf("Show ended sessions (1)"));
        expect(firstBoard).toContain("[Agents 1]");
        expect(firstBoard).toContain("Live");
        expect(firstBoard).not.toContain("Gone");
        const expanded = output.slice(output.indexOf("Show ended sessions (1)"));
        expect(expanded).toContain("Ended sessions");
        expect(expanded).toContain("Gone");
        expect(expanded).toContain("Hide ended sessions");
    });

    it("offers only active agents as recipients and says when a picked card's session has ended", async () => {
        const { database, gone } = await seedWithEnded();
        database.close();
        const listed = await menu("say\nback\nquit\n");
        const recipients = listed.slice(listed.indexOf("? Recipient"));
        expect(recipients).toContain("Live");
        expect(recipients).not.toContain("Gone");

        const fromCard = await menu("status\nended\nGone\nsay\nhello later\n\ny\nback\nquit\n");
        expect(fromCard).toContain(`Recipient: Gone (Codex) (${gone.agent_id})`);
        expect(fromCard).toContain("A recipient's session has ended; it reads this only if that session comes back.");
    });

    it("acknowledges a message to the person at the terminal when they open it", async () => {
        const { database, store, live } = await seedWithEnded();
        const person = store.ensureHumanParticipant("main", os.userInfo().username);
        const sent = store.sendMessage(live.agent_id, { to: person, kind: "note", text: "done, see the PR", replyTo: null, requestId: null });
        database.close();
        const receivedAt = async () => {
            const check = await openDatabase(path.join(directory, "data"));
            try {
                const row = check.prepare("SELECT received_at FROM message_receipt WHERE message_id = :id").get({ id: sent.message_id }) as { received_at: string | null };
                return row.received_at;
            }
            finally { check.close(); }
        };

        // seeing the list is not reading: only opening the message acknowledges it
        await menu("status\nmessages\nback\nquit\n");
        expect(await receivedAt()).toBeNull();
        await menu("status\nmessages\n1\nback\nquit\n");
        expect(await receivedAt()).not.toBeNull();
    });

    it("lists only open messages, says whom they wait on, and counts them on the tab", async () => {
        const { database, store, live } = await seedWithEnded();
        const other = store.join({ room: "main", displayName: "Other", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const done = store.sendMessage(live.agent_id, { to: other.agent_id, kind: "note", text: "already handled", replyTo: null, requestId: null });
        store.acknowledge(other.agent_id, [done.message_id]);
        store.sendMessage(live.agent_id, { to: other.agent_id, kind: "question", text: "still open", replyTo: null, requestId: null });
        database.close();

        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 1]"));
        expect(list).toContain("still open");
        expect(list).toMatch(/Live \(Codex\) (→|->) Other \(Codex\)/);
        expect(list).toContain("Pending 1");
        expect(list).not.toContain("already handled");
        expect(list).not.toContain("resolved");
    });

    it("sweeps residue when the board opens", async () => {
        const { database, store, live } = await seedWithEnded();
        const other = store.join({ room: "main", displayName: "Other", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const done = store.sendMessage(live.agent_id, { to: other.agent_id, kind: "note", text: "handled", replyTo: null, requestId: null });
        store.acknowledge(other.agent_id, [done.message_id]);
        const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
        database.prepare("UPDATE message_receipt SET received_at = :at WHERE message_id = :id").run({ at: longAgo, id: done.message_id });
        database.close();

        await menu("status\nback\nquit\n");
        const check = await openDatabase(path.join(directory, "data"));
        try {
            expect(check.prepare("SELECT COUNT(*) AS n FROM message").get()).toMatchObject({ n: 0 });
        }
        finally { check.close(); }
    });

    it("hides ended sessions from the status report and says how many", async () => {
        const { database } = await seedWithEnded();
        database.close();
        const { runStatus } = await import("../src/modules/cli/human-commands");
        const report = await runStatus({ json: false, language: "en", columns: 100, color: false, unicode: true });
        expect(report).toContain("1 agent");
        expect(report).toContain("1 ended session hidden");
        expect(report).toContain("Live");
        expect(report).not.toContain("Gone");
    });
});

describe("topics on the board", () => {
    async function seedMessages(topicLists: string[][]) {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const join = (displayName: string) => store.join({ room: "main", displayName, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const sender = join("Sender");
        const reader = join("Reader");
        topicLists.forEach((topics, index) => {
            store.sendMessage(sender.agent_id, { to: reader.agent_id, kind: "note", text: `message ${index}`, replyTo: null, requestId: null, topics });
        });
        database.close();
    }
    const headings = (list: string) => list.split("\n").filter((line) => /^  \S.*  \d+ open$/.test(line));

    it("groups open messages under their first topic, sorted by key, with untagged ones last", async () => {
        await seedMessages([[], ["concos_release"], ["concos_board", "concos_ui"], ["concos_board"]]);
        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 4]"));
        expect(headings(list)).toEqual(["  concos_board  2 open", "  concos_release  1 open", "  No topic  1 open"]);
        expect(list).toContain("Topics concos_board, concos_ui");
    });

    it("keeps the list without headings when no message has a topic", async () => {
        await seedMessages([[], []]);
        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 2]"));
        expect(list).toContain("message 1");
        expect(headings(list)).toEqual([]);
    });
});

describe("built interactive CLI", () => {
    it.each(["setup", "config", "ui"])("opens %s and lets piped input register settings", (command) => {
        const answers = (command == "ui" ? "setup\n" : "") + "codex\ny\nback\nquit\n";
        const result = spawnSync(process.execPath, [cli, command], {
            cwd: directory, env: process.env, input: answers, encoding: "utf8", timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("MCP registered for Codex CLI.");
        expect(inspectSetup({ host: "codex", home: path.join(directory, "user") }).room).toBe("main");
    });
});

describe("optional hooks on the registration screen", () => {
    const home = () => path.join(directory, "user");

    it("shows the hook state beside Claude Code and turns hooks on and off after a preview", async () => {
        applySetup(planSetup({ host: "claude", home: home() }));
        const on = await menu("claude\non\ny\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(on).toContain("MCP registered · Hooks off");
        expect(on).toContain("Claude Code · Optional hooks");
        expect(on.indexOf("Settings to add")).toBeLessThan(on.indexOf("Turn on these hooks?"));
        expect(on).toContain("Hooks turned on for Claude Code.");
        expect(on).toContain("MCP registered · Hooks on");
        expect(inspectHooks({ host: "claude", home: home() }).state).toBe("on");

        const off = await menu("claude\noff\ny\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(off.indexOf("Settings to remove")).toBeLessThan(off.indexOf("Remove these hooks?"));
        expect(off).toContain("Hooks turned off for Claude Code.");
        expect(inspectHooks({ host: "claude", home: home() }).state).toBe("off");
    });

    it("writes nothing when the hook preview is declined, and offers no hooks for other clients", async () => {
        applySetup(planSetup({ host: "codex", home: home() }));
        applySetup(planSetup({ host: "gemini", home: home() }));
        const declined = await menu("codex\non\n\nback\nquit\n", { host: "codex", startWithSetup: true });
        expect(declined).toContain("open /hooks in Codex");
        expect(fs.existsSync(path.join(home(), ".codex", "hooks.json"))).toBe(false);
        const gemini = await menu("gemini\nback\nquit\n", { host: "gemini", startWithSetup: true });
        expect(gemini).toContain("already has the same registration");
        expect(gemini).not.toContain("Optional hooks");
    });

    it("offers idle wake on the Claude Code row once its hooks are on, and shows it beside the client", async () => {
        applySetup(planSetup({ host: "claude", home: home() }));
        applySetup(planHooks({ host: "claude", home: home() }, "on"));
        const output = await menu("claude\nwake-on\ny\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(output).toContain("Idle wake, for Claude Code only");
        expect(output.indexOf("Codex sessions do not wake")).toBeLessThan(output.indexOf("Turn on idle wake?"));
        expect(output).toContain("Idle wake turned on for Claude Code.");
        expect(output).toContain("MCP registered · Hooks on · Wake on");
        expect(inspectWake({ host: "claude", home: home() })).toBe(true);
    });
});
