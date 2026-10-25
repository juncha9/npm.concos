import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMenu } from "../src/modules/cli/menu";
import type { MenuOptions } from "../src/modules/cli/menu";
import { applySetup, inspectHooks, inspectSetup, inspectWake, planHooks, planRegistration, planSetup, planUpdate } from "../src/modules/cli/setup";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";
import { TerminalScreen } from "./terminal-screen";

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
        // one preview names MCP, the hooks and idle wake, before the single question
        expect(output.indexOf("concos hook watch --host claude")).toBeLessThan(output.indexOf("Register these settings?"));
        expect(output).toContain("MCP, hooks and idle wake registered for Claude Code.");
        expect(inspectSetup({ host: "claude", home: path.join(directory, "user") })).toEqual({ registered: true, room: "main" });
        expect(inspectHooks({ host: "claude", home: path.join(directory, "user") }).state).toBe("on");
        expect(inspectWake({ host: "claude", home: path.join(directory, "user") })).toBe(true);
        expect(fs.existsSync(path.join(directory, ".codex"))).toBe(false);
    });

    it("clears concos settings backups that are no longer the newest, or a week old, when it opens", async () => {
        const home = path.join(directory, "user");
        fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
        const fresh = path.join(home, `.claude.json.concos-mcp-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
        const replaced = path.join(home, ".claude.json.concos-mcp-backup-2026-01-01T00-00-00-000Z");
        const expired = path.join(home, ".codex", "hooks.json.concos-mcp-backup-2026-01-01T00-00-00-000Z");
        for(const file of [fresh, replaced, expired]) fs.writeFileSync(file, "copy");
        await menu("quit\n", { selfUpdate: false });
        expect(fs.existsSync(fresh)).toBe(true);
        expect(fs.existsSync(replaced)).toBe(false);
        expect(fs.existsSync(expired)).toBe(false);
    });

    it("registers on Enter at the question, since yes is its default", async () => {
        const output = await menu("setup\ngemini\n\nback\nquit\n");
        expect(output).toContain("Register these settings? (Y/n)");
        expect(output).toContain("MCP registered for Gemini CLI.");
        expect(inspectSetup({ host: "gemini", home: path.join(directory, "user") }).registered).toBe(true);
    });

    it.each([
        "setup\ncodex\nn\nback\nquit\n", // No at confirmation.
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
        // the client's hooks open next; back leaves them untouched
        const output = await menu("claude\nback\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(output).toContain("User-wide registration");
        expect(output).toContain("already has the same registration");
        expect(output).not.toContain("hidden-token-value");
        expect(fs.readFileSync(path.join(directory, "user", ".claude", "settings.json"), "utf8")).toBe(before);
    });

    it("does not open a client whose settings concos cannot use, says what is wrong and writes nothing", async () => {
        applySetup(planSetup({ host: "claude", home: path.join(directory, "user") }));
        const hookFile = path.join(directory, "user", ".claude", "settings.json");
        fs.mkdirSync(path.dirname(hookFile));
        const broken = '{"hooks":{"Stop":[{"hooks":{"type":"command","command":"mine"}}]}}';
        fs.writeFileSync(hookFile, broken);
        const output = await menu("claude\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(output).toContain("Settings file needs fixing");
        expect(output).toContain("Claude Code settings need fixing before concos can use them:");
        expect(output).toContain(`${hookFile}: hooks.Stop[0].hooks must be a list`);
        expect(output).not.toContain("already has the same registration");
        expect(output).not.toContain("Claude Code · Hooks");
        expect(fs.readFileSync(hookFile, "utf8")).toBe(broken);
        expect(fs.readdirSync(path.dirname(hookFile))).toEqual(["settings.json"]);
    });

    it("brings each list back where it was drawn, without the pages it led to, and quits leaving the shell's screen as it was", async () => {
        applySetup(planRegistration({ host: "claude", home: path.join(directory, "user") }, { wake: true }));
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
        const screen = new TerminalScreen(100, 30);
        screen.write("C:\\Users\\me>concos\n");
        output.on("data", (chunk) => screen.write(chunk.toString()));
        const running = runMenu({ input, output, home: path.join(directory, "user") });
        const views: string[] = [];
        // menu: Register MCP, the second row; list: Claude Code; its hooks: Esc; the list again; Esc to the menu; Esc quits
        for(const step of ["2", "\r", "1", "\r", "\u001b", "look", "\u001b", "look", "\u001b"]) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            if(step == "look") views.push(screen.visible().join("\n"));
            else input.write(step);
        }
        await running;

        const [list, mainMenu] = views;
        expect(list.match(/User-wide registration/g)).toHaveLength(1);
        expect(list).not.toContain("already has the same registration");
        expect(list).toMatch(/[❯>] Claude Code/);
        expect(mainMenu).toContain("concos · Shared waiting room");
        expect(mainMenu).not.toContain("User-wide registration");
        expect(mainMenu).not.toMatch(/[✔√] concos · Shared waiting room/);
        expect(screen.transcript().join("\n").trim()).toBe("C:\\Users\\me>concos");
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
        const afterFirstRegistration = output.slice(output.indexOf("MCP, hooks and idle wake registered for Claude Code."));
        expect(afterFirstRegistration).toMatch(/[✔√] MCP registered/);
        expect(afterFirstRegistration).toContain("MCP registered · Hooks on · Wake on");
        expect(afterFirstRegistration).toContain("MCP, hooks and idle wake registered for Codex CLI.");
        expect(inspectWake({ host: "codex", home: path.join(directory, "user") })).toBe(true);
        expect(inspectHooks({ host: "codex", home: path.join(directory, "user") }).state).toBe("on");
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
        // the status bar under the question: the bar, the counts and this concos's version
        expect(output).toMatch(/\? Waiting room\n {2}(▓|!){16} {2}1 blocked {2}· {2}concos \d+\.\d+\.\d+\n/);
        expect(output).toContain("[Agents 1]  Messages 0");
        expect(output).toMatch(/1\) blocked +Server \(Codex\) · just now/);
        expect(output).toMatch(/ {10}Blocker  needs schema review/);
        expect(output).toMatch(/ {10}Task     message storage/);
        expect(output).toContain(agent.agent_id);
        expect(output).toContain("Stored messages; retry dedupe remains.");
        expect(output).toContain("merged the storage layer");
        expect(output.lastIndexOf("concos · Shared waiting room")).toBeGreaterThan(output.indexOf("merged the storage layer"));
    });

    it("flags cards that look wrong and lets the person take them down, all flagged at once or one from its card", async () => {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const join = (name: string) => store.join({ room: "dev", displayName: name, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const older = join("Twin");
        const newer = join("Twin");
        const solo = join("Solo");
        database.prepare("UPDATE agent SET last_call_at = :at WHERE id = :id").run({ at: new Date(Date.now() - 60_000).toISOString(), id: older.agent_id });
        database.close();

        const flagged = await menu("status\nretire\ny\nback\nquit\n");
        expect(flagged).toMatch(/ {10}Check {4}a newer card has this name · take this one down/);
        expect(flagged).toContain("Take down flagged cards (1)");
        expect(flagged).toContain("Take down Twin (Codex)? It leaves the room");
        expect(flagged).toContain("Took down 1 card.");
        const fromCard = await menu("status\nSolo\nretire\ny\nback\nquit\n");
        expect(fromCard).toContain("Take down this card");
        expect(fromCard).toContain("Took down 1 card.");

        const check = await openDatabase(path.join(directory, "data"));
        try {
            const left = (id: string) => (check.prepare("SELECT left_at FROM agent WHERE id = :id").get({ id }) as { left_at: string | null }).left_at != null;
            expect([left(older.agent_id), left(newer.agent_id), left(solo.agent_id)]).toEqual([true, false, true]);
        }
        finally { check.close(); }
    });

    it("keeps an agent under the project its session started in and shows the folder it works in now", async () => {
        const agent = await seedRoom();
        const docs = path.join(directory, "docs-repo");
        fs.mkdirSync(docs);
        const database = await openDatabase(path.join(directory, "data"));
        new RoomStore(database).checkIn(agent.agent_id, {
            cursor: null, expectedRevision: null, update: { task: "design notes", currentDirectory: docs }, checkpoint: null, receivedMessageIds: [],
        });
        database.close();

        const output = await menu("status\nback\nquit\n");
        expect(output).toContain(`${path.basename(directory)}  ${directory}`);
        expect(output).toMatch(/ {10}Folder {3}docs-repo\n +Task {5}design notes/);
    });

    it("shows where an agent works from its project's root: its start folder when inside, nothing at the root", async () => {
        const docs = path.join(directory, "docs-repo");
        fs.mkdirSync(docs);
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        // a session that started in a folder inside its project, as cards from before 0.1.11 can be
        const agent = store.join({ room: "main", displayName: "Server", client: "Codex", workingDirectory: docs, workspaceRoot: directory, resumeHandle: null });
        database.close();
        expect(await menu("status\nback\nquit\n")).toMatch(/ {10}Folder {3}docs-repo\n/);

        // then it moves up to the project root, which the project heading already names
        const again = await openDatabase(path.join(directory, "data"));
        new RoomStore(again).checkIn(agent.agent_id, {
            cursor: null, expectedRevision: null, update: { currentDirectory: directory }, checkpoint: null, receivedMessageIds: [],
        });
        again.close();
        const atRoot = await menu("status\nback\nquit\n");
        expect(atRoot).toContain("Server (Codex)");
        expect(atRoot).not.toContain("Folder");
    });

    it("shows an agent's role on its row and lets the person at the board set it", async () => {
        const agent = await seedRoom();
        const database = await openDatabase(path.join(directory, "data"));
        new RoomStore(database).checkIn(agent.agent_id, {
            cursor: null, expectedRevision: null, update: { role: "storage owner", task: "message storage" }, checkpoint: null, receivedMessageIds: [],
        });
        database.close();

        const output = await menu("status\nServer\nrole\nreview owner\nback\nquit\n");
        expect(output).toMatch(/ {10}Role {5}storage owner\n +Task {5}message storage/);
        expect(output).toContain("Role (Enter keeps it, - clears it)");
        expect(output).toMatch(/ {10}Role {5}review owner/);
        const check = await openDatabase(path.join(directory, "data"));
        try {
            expect(check.prepare("SELECT role, task FROM agent WHERE id = :id").get({ id: agent.agent_id })).toEqual({ role: "review owner", task: "message storage" });
        }
        finally { check.close(); }
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
        for(const key of ["1", "\r", "\r", "\u001b", "\u001b", "\u001b"]) {
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

        // the tab's actions take rows 1 and 2, above the messages
        const output = await menu("status\nmessages\n3\nback\nquit\n");
        expect(output).toContain("Server (Codex) (1 unread)");
        expect(output).toContain(" Agents 1  [Messages 1]");
        expect(output).toMatch(/1\) Send a message +to all, several agents or one\n[^\n]*2\) Search messages/);
        expect(output).toMatch(/\n {2}Reviewer {2}1 message\n/);
        expect(output).toMatch(/3\) #1 QUESTION {2}(→|->) Server \(Codex\) +just now · Pending Server/);
        const list = output.slice(output.indexOf("[Messages 1]"), output.indexOf("From  Reviewer"));
        // two preview lines, the second ending in an ellipsis
        expect(list).toMatch(/ {2}First line\n +Second line with details(…|\.\.\.)\n/);
        expect(list).not.toContain("Original message text");
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
        // menu: Enter concos; board: Tab to Messages, where the cursor starts on the message below
        // the actions, open it, Esc back to the tab, ← back to Agents; Esc twice leaves
        for(const key of ["1", "\r", "\t", "SNAP", "\r", "\u001b", "SNAP", "\u001b[D", "SNAP", "\u001b", "\u001b"]) {
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

    it("stores a message sent from the Messages tab for the selected participant after confirmation", async () => {
        const agent = await seedRoom();
        // Enter at the topics prompt files the message under none
        const output = await menu(`status\nmessages\nsend\n${agent.agent_id}\n검증 메시지\n\ny\nback\nquit\n`);
        expect(output).toContain("1 recipient(s)");
        const database = await openDatabase(path.join(directory, "data"));
        try {
            expect(database.prepare("SELECT recipient_agent_id, kind, body FROM message").get()).toMatchObject({ recipient_agent_id: agent.agent_id, kind: "note", body: "검증 메시지" });
        }
        finally { database.close(); }
    });

    it("does not store a message when confirmation is declined", async () => {
        const agent = await seedRoom();
        await menu(`status\nmessages\nsend\n${agent.agent_id}\n취소할 메시지\n\n\nback\nquit\n`);
        const database = await openDatabase(path.join(directory, "data"));
        try { expect(database.prepare("SELECT COUNT(*) AS count FROM message").get()).toMatchObject({ count: 0 }); }
        finally { database.close(); }
    });

    it("returns to the board, sending nothing, when Esc is pressed inside the Messages tab's send flow", async () => {
        const agent = await seedRoom();
        const output = await menu(`status\nmessages\nsend\n${agent.agent_id}\nESC\nback\nquit\n`);
        // the board again after the Message prompt, not the main menu
        expect(output.lastIndexOf("[Messages 0]")).toBeGreaterThan(output.indexOf("? Message"));
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

        const output = await menu("status\nmessages\nsend\nseveral\nFirst\nSecond\ndone\nreview the board\nboard\nConcos board, concos-ui\ny\nback\nquit\n");
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

    it("uses English for menu labels, reports and empty-state guidance, with the board first", async () => {
        const output = await menu("status\nquit\n");
        expect(output.indexOf("Enter concos")).toBeLessThan(output.indexOf("Register MCP"));
        // sending lives on the board: the Messages tab and an agent's card
        expect(output).not.toContain("Send a message");
        expect(output).toContain("No agents have joined the shared waiting room yet");
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
        const listed = await menu("status\nmessages\nsend\nback\nback\nquit\n");
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
        await menu(`status\nmessages\n#${sent.message_id}\nback\nquit\n`);
        expect(await receivedAt()).not.toBeNull();
    });

    it("lists open and received messages together, says whom open ones wait on, and counts both on the tab", async () => {
        const { database, store, live } = await seedWithEnded();
        const other = store.join({ room: "main", displayName: "Other", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const done = store.sendMessage(live.agent_id, { to: other.agent_id, kind: "note", text: "already handled", replyTo: null, requestId: null });
        store.acknowledge(other.agent_id, [done.message_id]);
        store.sendMessage(live.agent_id, { to: other.agent_id, kind: "question", text: "still open", replyTo: null, requestId: null });
        database.close();

        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 2]"));
        expect(list).toContain("still open");
        expect(list).toContain("  Live (Codex)  2 messages");
        expect(list).toMatch(/QUESTION {2}(→|->) Other \(Codex\)/);
        expect(list).toContain("Pending Other");
        expect(list).toContain("already handled");
        expect(output).not.toMatch(/earlier messages/i);
    });

    it("shows a message everyone received in the list, without a pending mark", async () => {
        const { database, store, live } = await seedWithEnded();
        const other = store.join({ room: "main", displayName: "Other", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const done = store.sendMessage(live.agent_id, { to: other.agent_id, kind: "note", text: "already handled", replyTo: null, requestId: null });
        store.acknowledge(other.agent_id, [done.message_id]);
        database.close();

        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 1]"));
        expect(list).toContain("already handled");
        expect(list).not.toContain("Pending");
        expect(list).not.toContain("No messages.");
    });

    it("sweeps residue when the board opens", async () => {
        const { database, store, live } = await seedWithEnded();
        const other = store.join({ room: "main", displayName: "Other", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const done = store.sendMessage(live.agent_id, { to: other.agent_id, kind: "note", text: "handled", replyTo: null, requestId: null });
        store.acknowledge(other.agent_id, [done.message_id]);
        const pastLifetime = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
        database.prepare("UPDATE message SET created_at = :at WHERE id = :id").run({ at: pastLifetime, id: done.message_id });
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

describe("message groups on the board", () => {
    /** Sends `[sender name, topics, text]` in order, all to one reader; the text defaults to `message <index>`. */
    async function seedMessages(sent: [string, string[], string?][]) {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const join = (displayName: string) => store.join({ room: "main", displayName, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const reader = join("Reader");
        const senders = new Map<string, string>();
        sent.forEach(([name, topics, text], index) => {
            if(senders.has(name) == false) {
                senders.set(name, join(name).agent_id);
            }
            store.sendMessage(senders.get(name)!, { to: reader.agent_id, kind: "note", text: text ?? `message ${index}`, replyTo: null, requestId: null, topics });
        });
        database.close();
    }
    const headings = (list: string) => list.split("\n").filter((line) => /^  \S.*  \d+ messages?$/.test(line));

    it("groups messages by sender, the sender of the newest message first", async () => {
        await seedMessages([["Alpha", []], ["Beta", []], ["Alpha", []]]);
        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 3]"));
        expect(headings(list)).toEqual(["  Alpha (Codex)  2 messages", "  Beta (Codex)  1 message"]);
        // newest first within a group
        expect(list.indexOf("message 2")).toBeLessThan(list.indexOf("message 0"));
    });

    it("shows every topic a message carries on its row", async () => {
        await seedMessages([["Alpha", ["concos_release"]], ["Alpha", ["concos_board", "concos_ui"]], ["Alpha", []]]);
        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 3]"));
        expect(list).toContain("Topics concos_release");
        expect(list).toContain("Topics concos_board, concos_ui");
        expect(list.match(/Topics /g)).toHaveLength(2);
    });

    it("lists posts to the whole room first, under Notices, with their edit time and no pending names", async () => {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const join = (displayName: string) => store.join({ room: "main", displayName, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const reader = join("Reader");
        const poster = join("Poster");
        store.sendMessage(reader.agent_id, { to: poster.agent_id, kind: "note", text: "direct note", replyTo: null, requestId: null });
        const posted = store.sendMessage(poster.agent_id, { to: "all", kind: "notice", text: "server restarts at 15:00", replyTo: null, requestId: null });
        store.editPost(poster.agent_id, { messageId: posted.message_id, text: "server is back" });
        database.close();

        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 2]"));
        expect(list).toContain("\n  Notices\n\n  Poster (Codex)  1 post\n");
        expect(list).toMatch(/#2 NOTICE +edited just now\n +server is back\n/);
        expect(list.indexOf("server is back")).toBeLessThan(list.indexOf("\n  Messages\n"));
        expect(list.indexOf("\n  Messages\n")).toBeLessThan(list.indexOf("direct note"));
        expect(list).not.toContain("server restarts");
    });

    it("asks each live agent with posts, by question, to tidy them, naming its posts", async () => {
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const join = (displayName: string) => store.join({ room: "main", displayName, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const poster = join("Poster");
        const gone = join("Gone");
        const post = (from: string, text: string) => store.sendMessage(from, { to: "all", kind: "notice", text: text, replyTo: null, requestId: null }).message_id;
        const first = post(poster.agent_id, "server restarts at 15:00\nsecond line");
        const second = post(poster.agent_id, "migration after the restart");
        post(gone.agent_id, "from a closed session");
        store.disconnect([gone.agent_id]);
        database.close();

        const output = await menu("status\nmessages\ntidy\ny\nback\nquit\n");
        expect(output).toContain("Ask senders to tidy notices  1 agent");
        expect(output).toContain("Ask Poster (Codex) to tidy their notices?");
        expect(output).toContain("Asked 1 agent to tidy its notices.");
        const check = await openDatabase(path.join(directory, "data"));
        try {
            const asked = check.prepare("SELECT recipient_agent_id, kind, body FROM message WHERE recipient_scope = 'direct'").all() as { recipient_agent_id: string; kind: string; body: string }[];
            expect(asked).toHaveLength(1);
            expect(asked[0]).toMatchObject({ recipient_agent_id: poster.agent_id, kind: "question" });
            expect(asked[0].body.split("\n").slice(1)).toEqual([`#${second} migration after the restart`, `#${first} server restarts at 15:00…`]);
        }
        finally { check.close(); }
    });

    it("lets the person at the board take a post down after confirming", async () => {
        await seedMessages([["Poster", []]]);
        const database = await openDatabase(path.join(directory, "data"));
        const store = new RoomStore(database);
        const posterId = store.findAgentInRoom("main", "Poster");
        const posted = store.sendMessage(posterId, { to: "all", kind: "notice", text: "stale notice", replyTo: null, requestId: null }).message_id;
        database.close();

        const kept = await menu(`status\nmessages\n#${posted}\nremove\nn\nback\nquit\n`);
        expect(kept).not.toContain(`Removed post #${posted}.`);
        const output = await menu(`status\nmessages\n#${posted}\nremove\ny\nback\nquit\n`);
        expect(output).toContain(`Remove post #${posted} by Poster (Codex)?`);
        expect(output).toContain(`Removed post #${posted}.`);
        const check = await openDatabase(path.join(directory, "data"));
        try {
            expect(check.prepare("SELECT id FROM message WHERE id = :id").get({ id: posted })).toBeUndefined();
        }
        finally { check.close(); }
    });

    it("leaves a lead that repeats the sender out of the preview", async () => {
        await seedMessages([
            ["Alpha", [], "[Alpha → Reader] build is green"],
            ["Alpha", [], "Alpha → Reader: schema frozen"],
            ["Alpha", [], "[Alphabet] stays as written"],
            ["Alpha", [], "[Alpha]"],
        ]);
        const output = await menu("status\nmessages\nback\nquit\n");
        const list = output.slice(output.indexOf("[Messages 4]"));
        expect(list).toMatch(/\n +build is green\n/);
        expect(list).toMatch(/\n +schema frozen\n/);
        expect(list).not.toContain("Reader]");
        // another name that only starts the same way, and a lead with nothing after it, stay
        expect(list).toContain("[Alphabet] stays as written");
        expect(list).toMatch(/\n +\[Alpha\]\n/);
    });

    it("opens message search from the Messages tab and comes back to the board", async () => {
        await seedMessages([["Alpha", []]]);
        const output = await menu("status\nmessages\nsearch\nback\nback\nquit\n");
        expect(output).toMatch(/\d+\) Search messages +by text, topic or sender/);
        expect(output).toContain("Search messages by");
        expect(output.lastIndexOf("[Messages 1]")).toBeGreaterThan(output.indexOf("Search messages by"));
    });

    it("draws sender rules on a terminal and inverts the selected block's header", async () => {
        vi.stubEnv("NO_COLOR", undefined);
        await seedMessages([["Alpha", []], ["Alpha", []]]);
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 30 });
        let screen = "";
        output.on("data", (chunk) => { screen += chunk.toString(); });
        const running = runMenu({ input, output, home: path.join(directory, "user") });
        let frame = "";
        // menu: Enter concos; board: Tab to Messages; Esc twice leaves
        for(const key of ["1", "\r", "\t", "SNAP", "\u001b", "\u001b"]) {
            await new Promise((resolve) => setTimeout(resolve, 30));
            if(key == "SNAP") {
                frame = screen.slice(screen.lastIndexOf("\u001b[J") + 3);
                continue;
            }
            input.write(key);
        }
        await running;

        expect(frame.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")).toMatch(/ {2}(──|--) Alpha \(Codex\) · 2 messages (─|-)+\n/);
        const inverted = frame.split("\n").filter((line) => line.includes("\u001b[7m"));
        expect(inverted).toHaveLength(1);
        expect(inverted[0]).toContain("#2");
    });
});

describe("built interactive CLI", () => {
    it.each(["setup", "config", "ui"])("opens %s and lets piped input register settings", (command) => {
        const answers = (command == "ui" ? "setup\n" : "") + "codex\ny\nback\nquit\n";
        const result = spawnSync(process.execPath, [cli, command], {
            cwd: directory, env: process.env, input: answers, encoding: "utf8", timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("MCP, hooks and idle wake registered for Codex CLI.");
        expect(inspectWake({ host: "codex", home: path.join(directory, "user") })).toBe(true);
        expect(inspectSetup({ host: "codex", home: path.join(directory, "user") }).room).toBe("main");
    });
});

describe("hooks on the registration screen", () => {
    const home = () => path.join(directory, "user");

    it("shows the hook state beside Claude Code and turns hooks on and off after a preview", async () => {
        applySetup(planSetup({ host: "claude", home: home() }));
        const on = await menu("claude\non\ny\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(on).toContain("MCP registered · Hooks off");
        expect(on).toContain("Claude Code · Hooks");
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
        expect(gemini).not.toContain("Gemini CLI · Hooks");
    });

    it("unregisters a client from its row, taking out only the concos entry and hooks", async () => {
        const claude = { host: "claude", home: home() };
        applySetup(planRegistration(claude, { wake: true }));
        applySetup(planSetup({ host: "gemini", home: home() }));
        const output = await menu("claude\nremove\ny\ngemini\nremove\ny\nback\nquit\n", { host: "claude", startWithSetup: true });
        expect(output.indexOf("Settings to remove")).toBeLessThan(output.indexOf("Remove concos from this client?"));
        expect(output).toContain("concos removed from Claude Code.");
        expect(output).toContain("concos removed from Gemini CLI.");
        expect(inspectSetup(claude).registered).toBe(false);
        expect(inspectHooks(claude).state).toBe("off");
        expect(inspectSetup({ host: "gemini", home: home() }).registered).toBe(false);
    });

    it("offers to update a registration an earlier concos wrote, from the row that says so", async () => {
        const claude = { host: "claude", home: home() };
        applySetup(planRegistration(claude, { wake: true }));
        // this concos runs as an installed CLI, which registers node on its cli.js directly
        const cli = path.join(directory, "prefix", "node_modules", "concos-mcp", "dist", "cli.js");
        fs.mkdirSync(path.dirname(cli), { recursive: true });
        fs.writeFileSync(cli, "");
        const argv = process.argv[1];
        process.argv[1] = cli;
        try {
            const output = await menu("claude\ny\nback\nquit\n", { host: "claude", startWithSetup: true });
            expect(output).toContain("MCP registered · Hooks on · Wake on · Update available");
            expect(output.indexOf("Settings to add")).toBeLessThan(output.indexOf("Update the registration?"));
            expect(output).toContain("Registration updated.");
            expect(planUpdate(claude)).toEqual([]);
            expect(inspectWake(claude)).toBe(true);
        }
        finally { process.argv[1] = argv; }
    });

    it.each(["claude", "codex"])("offers idle wake on the %s row once its hooks are on, and shows it beside the client", async (host) => {
        const input = { host, home: home() };
        const label = host == "claude" ? "Claude Code" : "Codex CLI";
        applySetup(planSetup(input));
        applySetup(planHooks(input, "on"));
        const output = await menu(`${host}\nwake-on\ny\nback\nquit\n`, { host, startWithSetup: true });
        expect(output).toContain("Idle wake wakes a waiting session");
        expect(output.indexOf(`A waiting ${label} session wakes`)).toBeLessThan(output.indexOf("Turn on idle wake?"));
        if(host == "codex") {
            expect(output.indexOf("codex queue")).toBeLessThan(output.indexOf("Turn on idle wake?"));
            expect(output.indexOf("open /hooks in Codex")).toBeLessThan(output.indexOf("Turn on idle wake?"));
        }
        expect(output).toContain(`Idle wake turned on for ${label}.`);
        expect(output).toContain("MCP registered · Hooks on · Wake on");
        expect(inspectWake(input)).toBe(true);
    });
});
