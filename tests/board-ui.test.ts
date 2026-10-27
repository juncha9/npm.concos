import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showRoomBoard } from "../src/modules/cli/room-board";
import type { RoomBoardOptions } from "../src/modules/cli/room-board";
import { showMessageSearch } from "../src/modules/cli/message-search";
import { Prompter, PromptBackError, PromptClosedError } from "../src/modules/cli/prompter";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";
import type { AgentIssue } from "../src/modules/store/room-store";
import { TerminalScreen } from "./terminal-screen";
import { agentLocation, recentFolderLines, renderAgentDetailHeader, renderAgentDetailBody, shortenPath } from "../src/modules/cli/status-renderer";
import { displayWidth } from "../src/modules/cli/prompter";

let directory: string;
let database: DatabaseSync;
let store: RoomStore;

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-board-ui-"));
    vi.stubEnv("CONCOS_HOME", directory);
    vi.stubEnv("CODEX_HOME", path.join(directory, "user", ".codex"));
    vi.stubEnv("CONCOS_REDUCED_MOTION", "1");
    vi.stubEnv("CONCOS_LOG_LEVEL", "none");
    database = await openDatabase(directory);
    store = new RoomStore(database);
});

afterEach(() => {
    vi.restoreAllMocks();
    database.close();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
});

function agent(name: string, project = "project"): string {
    return store.join({ displayName: name, client: "Codex", workingDirectory: path.join(directory, project), workspaceRoot: null, resumeHandle: null }).agent_id;
}

function update(id: string, fields: Parameters<RoomStore["checkIn"]>[1]["update"]): void {
    store.checkIn(id, { update: fields, receivedMessageIds: [], checkpoint: null, cursor: null, expectedRevision: null });
}

function send(from: string, to: string | string[], text = "First preview\nFull second line", topics = ["concos_dev"]): number {
    return store.sendMessage(from, { to, text, topics, kind: "question", replyTo: null, requestId: null }).message_id;
}

async function board(answers: string, sendMessage: RoomBoardOptions["send"] = async () => undefined): Promise<string> {
    const input = Readable.from([answers]);
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    const prompter = new Prompter(input, output);
    try {
        await showRoomBoard(prompter, { language: "en", columns: 80, send: sendMessage });
        expect(prompter.transient).toBe(false);
        return text;
    }
    finally { prompter.close(); }
}

function terminal(columns = 80, rows = 24) {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
    const screen = new TerminalScreen(columns, rows);
    screen.write("D:\\work>concos\n");
    output.on("data", (chunk) => screen.write(chunk.toString()));
    const prompter = new Prompter(input, output);
    const running = showRoomBoard(prompter, { language: "en", columns, send: async () => undefined });
    // Attach immediately, including when an assertion fails before the normal exit.
    void running.catch(() => undefined);
    return {
        input, screen, running,
        visible: () => screen.visible().join("\n"),
        key: async (key: string) => {
            input.write(key);
            await new Promise<void>((resolve) => setImmediate(resolve));
        },
        close: async () => {
            input.end();
            try { await running; }
            catch(error) { if(!(error instanceof PromptClosedError)) throw error; }
            finally { prompter.close(); }
        },
    };
}

describe("board message actions", () => {
    it("opens an older waiting message in full without acknowledging or delivering it for the agent", async () => {
        const reporter = agent("Reporter");
        const reader = agent("Reader");
        const id = send(reporter, reader, "Waiting preview\nUnabridged older message content");
        for(let index = 0; index < 55; index += 1) send(reporter, "all", `Newer post ${index}`);
        expect(store.getRoomOverview("main", 50).messages.some((message) => message.id == id)).toBe(false);
        const output = await board(`Reader\n#${id}\nback\nback\nback\n`);
        expect(output).toContain("Waiting messages");
        expect(output).toContain("Wake target · not yet notified");
        expect(output).toContain("Full text not delivered");
        expect(output).toContain("Unabridged older message content");
        expect(database.prepare("SELECT delivered_at, received_at FROM message_receipt WHERE message_id = ? AND agent_id = ?").get(id, reader))
            .toEqual({ delivered_at: null, received_at: null });
        expect(store.pendingFor(reader).map((message) => message.id)).toEqual([id]);
    });

    it.each([false, true])("replies to a person's %s group message with the source id and topics, acknowledging only that person", async (group) => {
        const reporter = agent("Reporter");
        const reader = agent("Reader");
        const person = store.ensureHumanParticipant("main", os.userInfo().username);
        const id = send(reporter, group ? [person, reader] : person);
        const action = vi.fn<RoomBoardOptions["send"]>().mockResolvedValue(undefined);
        const output = await board(`messages\n#${id}\nreply\nback\n`, action);
        expect(output).toContain("Reply to sender");
        expect(action).toHaveBeenCalledExactlyOnceWith(reporter, { messageId: id, topics: ["concos_dev"] });
        expect(database.prepare("SELECT received_at FROM message_receipt WHERE message_id = ? AND agent_id = ?").get(id, person))
            .toEqual({ received_at: expect.any(String) });
        if(group) {
            expect(database.prepare("SELECT delivered_at, received_at FROM message_receipt WHERE message_id = ? AND agent_id = ?").get(id, reader))
                .toEqual({ delivered_at: null, received_at: null });
        }
    });

    it("messages an agent traffic's sender by id without attaching a forbidden reply reference", async () => {
        const reporter = agent("Same name");
        agent("Same name");
        const reader = agent("Reader");
        const id = send(reporter, reader);
        const action = vi.fn<RoomBoardOptions["send"]>().mockResolvedValue(undefined);
        const output = await board(`messages\n#${id}\nsend\nback\n`, action);
        expect(output).toContain("Message the sender");
        expect(output).not.toContain("Reply to sender");
        expect(action).toHaveBeenCalledExactlyOnceWith(reporter, undefined);
        expect(store.pendingFor(reader).map((message) => message.id)).toEqual([id]);
    });

    it("allows replies to room posts", async () => {
        const reporter = agent("Reporter");
        const id = send(reporter, "all");
        const action = vi.fn<RoomBoardOptions["send"]>().mockResolvedValue(undefined);
        await board(`messages\n#${id}\nreply\nback\n`, action);
        expect(action).toHaveBeenCalledExactlyOnceWith(reporter, { messageId: id, topics: ["concos_dev"] });
    });

    it.each(["human", "left"])("does not offer a sender action for a %s sender", async (kind) => {
        const reporter = kind == "human" ? store.ensureHumanParticipant("main", "Reporter") : agent("Reporter");
        const reader = agent("Reader");
        const id = send(reporter, reader);
        if(kind == "left") store.retireAgent(reporter);
        const output = await board(`messages\n#${id}\nback\nback\n`);
        expect(output).not.toContain("Reply to sender");
        expect(output).not.toContain("Message the sender");
    });

    it("uses the same sender actions when opening a search result", async () => {
        const reporter = agent("Reporter");
        const person = store.ensureHumanParticipant("main", os.userInfo().username);
        const id = send(reporter, person, "Find this cart message");
        const action = vi.fn<RoomBoardOptions["send"]>().mockResolvedValue(undefined);
        await board(`messages\nsearch\ntext\ncart\nmessage:${id}\nreply\nback\nESC\nback\nback\n`, action);
        expect(action).toHaveBeenCalledExactlyOnceWith(reporter, { messageId: id, topics: ["concos_dev"] });
    });

    it("looks up retained messages and their sender without writes, and returns null after removal", () => {
        const reporter = agent("Reporter");
        const id = send(reporter, "all");
        database.exec("PRAGMA query_only = ON");
        expect(store.messageForBoard(id)).toMatchObject({ id, text: "First preview\nFull second line", topics: ["concos_dev"] });
        expect(store.messageSender(id)).toEqual({ agent_id: reporter, human: false, left: false });
        expect(store.messageForBoard(id + 1)).toBe(null);
        expect(store.messageSender(id + 1)).toBe(null);
        database.exec("PRAGMA query_only = OFF");
        store.removePosts(null, [id]);
        expect(store.messageForBoard(id)).toBe(null);
        expect(store.messageSender(id)).toBe(null);
    });
});

describe("board views and navigation", () => {
    it("puts each tab's actions before its objects and removes sending from Messages", async () => {
        const live = agent("Alpha");
        const ended = agent("Ended");
        store.leave(ended, { summary: null, nextStep: null, checkpoint: null });
        store.ensureHumanParticipant("main", "Person");
        send(live, "all", "Visible board post");
        const output = await board("messages\nback\n");
        const tabs = output.split("? Waiting room").slice(1);
        const agents = tabs[0];
        expect(agents.indexOf("Compact view")).toBeLessThan(agents.indexOf("Alpha (Codex)"));
        expect(agents.indexOf("Show ended sessions (1)")).toBeLessThan(agents.indexOf("Alpha (Codex)"));
        expect(agents.indexOf(") Back")).toBeLessThan(agents.indexOf("Alpha (Codex)"));
        expect(agents.indexOf("Alpha (Codex)")).toBeLessThan(agents.indexOf("People"));
        const messages = tabs[1];
        expect(messages).toMatch(/1\) Search messages[\s\S]*2\) Ask senders to tidy notices[\s\S]*3\) Back/);
        expect(messages.indexOf(") Back")).toBeLessThan(messages.indexOf("Visible board post"));
        expect(messages).not.toContain("Send a message");
        expect(messages.slice(messages.indexOf("Visible board post"))).not.toMatch(/\d+\) Back/);
    });

    it("starts on objects when entering a tab and keeps a toggled action selected", async () => {
        const alpha = agent("Alpha");
        agent("Beta");
        const ended = agent("Ended");
        store.leave(ended, { summary: null, nextStep: null, checkpoint: null });
        send(alpha, "all");
        const tty = terminal(80, 30);
        try {
            await vi.waitFor(() => expect(tty.visible()).toMatch(/[>❯].*Alpha \(Codex\)/));
            await tty.key("1");
            await tty.key("\r");
            expect(tty.visible()).toMatch(/[>❯] Compact view\s+on/);
            await tty.key("\t");
            expect(tty.visible()).toMatch(/[>❯].*#1 QUESTION/);
            await tty.key("\u001b[D");
            expect(tty.visible()).toMatch(/[>❯].*Alpha \(Codex\)/);
            await tty.key("2");
            await tty.key("\r");
            expect(tty.visible()).toMatch(/[>❯] Hide ended sessions \(1\)/);
        }
        finally { await tty.close(); }
    });

    it.each([54, 80, 100])("shows Card before waiting messages and long detail at %s columns", async (columns) => {
        const reader = agent("Reader");
        const writer = agent("Writer");
        update(reader, { role: "Owner", task: "Implement storage", nextStep: "Review", blocker: "Need answer", summary: "Full summary ".repeat(120) });
        send(writer, reader, "Pending question");
        database.prepare("UPDATE agent SET recent_folder_list = ? WHERE id = ?").run(JSON.stringify([
            { path: "src/store", at: new Date().toISOString() },
            { path: "x".repeat(120), at: new Date(Date.now() - 60000).toISOString() },
        ]), reader);
        const output = await board("Reader\nback\nback\n");
        const detail = output.slice(output.indexOf("? Reader (Codex)"), output.indexOf("Choice (1):", output.indexOf("? Reader (Codex)")));
        expect(detail).toMatch(/1\) Name[\s\S]*2\) Role[\s\S]*3\) Send a message[\s\S]*4\) Take down this card[\s\S]*5\) Back[\s\S]*Waiting messages \(1\)/);
        expect(detail.indexOf("Waiting messages (1)")).toBeLessThan(detail.indexOf("Task        Implement storage"));
        expect(detail.indexOf("Summary")).toBeLessThan(detail.indexOf("Recent folders"));
        expect(detail.match(/\bRole\b/g)).toHaveLength(1);
        const tty = terminal(columns, 24);
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 2]"));
            await tty.key("\r");
            expect(tty.visible()).toMatch(/[>❯] Name/);
            expect(tty.visible()).toContain("Take down this card");
            expect(tty.visible()).toContain("Back");
            expect(tty.visible()).toMatch(/Send a message[^\n]*\n\s+[-─]+\n\s+Take down this card[^\n]*\n\s+[-─]+\n\s+Back/);
            for(let page = 0; page < 15; page += 1) await tty.key("\u001b[6~");
            expect(tty.visible()).toContain("Recent folders");
            expect(tty.visible()).toContain("src/store");
            const longFolder = tty.screen.visible().find((line) => line.includes("xxx") && line.includes("1m ago"));
            expect(longFolder).toBeDefined();
            expect(displayWidth(longFolder!)).toBeLessThan(columns);
            await tty.key("\u001b");
            expect(tty.visible()).toContain("[Agents 2]");
        }
        finally { await tty.close(); }
    });

    it("renames and sets a role through the detail menu, preserving Enter and dash in line mode", async () => {
        const target = agent("Original");
        update(target, { role: "API owner" });
        const output = await board("Original\nname\nRenamed\nrole\nDeployments\nrole\n\nrole\n-\nback\nback\n");
        expect(output).toContain("? Name (Original)");
        expect(output).toContain("? Role (- to remove) (Deployments)");
        expect(output).toContain("? Renamed (Codex)");
        expect(output).toMatch(/Role\s+none/);
        expect(output.match(/\? Waiting room/g)).toHaveLength(2);
        expect(database.prepare("SELECT display_name, role FROM agent WHERE id = ?").get(target)).toEqual({ display_name: "Renamed", role: "" });
    });

    it("reports a taken name and hides agent editing actions on human cards", async () => {
        const target = agent("Original");
        agent("Taken", "other-project");
        const output = await board("Original\nname\nTaken\nback\nback\n");
        expect(output).toContain("Another active card in this room already uses that name; it was not changed.");
        expect(database.prepare("SELECT display_name FROM agent WHERE id = ?").get(target)).toEqual({ display_name: "Original" });
        store.ensureHumanParticipant("main", "Reviewer");
        const human = await board("Reviewer\nback\nback\n");
        expect(human).not.toMatch(/\d+\) Name/);
        expect(human).not.toMatch(/\d+\) Role/);
    });

    it("edits prefilled name and role in the board and cancels each with Esc", async () => {
        const target = agent("Original");
        update(target, { role: "API owner" });
        const tty = terminal();
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 1]"));
            await tty.key("\r");
            for(const field of ["name", "role"]) {
                for(const cancel of [true, false]) {
                    await tty.key(field == "name" ? "1" : "2");
                    await tty.key("\r");
                    if(field == "name") {
                        expect(tty.visible()).toContain("Name Original");
                    }
                    else {
                        expect(tty.visible()).toContain("Role (clear to remove) API owner");
                    }
                    await tty.key("2");
                    if(cancel == true) {
                        await tty.key("\u001b");
                    }
                    else {
                        await tty.key("\r");
                    }
                    expect(tty.visible()).not.toContain("? Waiting room");
                    expect(tty.visible()).toContain("its next join may set it back");
                    const saved = database.prepare("SELECT display_name, role FROM agent WHERE id = ?").get(target)!;
                    if(field == "name") {
                        let expected = "Original2";
                        if(cancel == true) {
                            expected = "Original";
                        }
                        expect(saved.display_name).toBe(expected);
                        expect(tty.visible()).toContain(`? ${expected} (Codex)`);
                        expect(tty.visible()).toMatch(cancel ? /[>❯] Name/ : /[>❯] Role/);
                    }
                    else {
                        let expected = "API owner2";
                        if(cancel == true) {
                            expected = "API owner";
                        }
                        expect(saved.role).toBe(expected);
                        expect(tty.visible()).toMatch(cancel ? /[>❯] Role/ : /[>❯] Send a message/);
                    }
                    expect(tty.visible()).not.toMatch(/[✔√]/);
                }
            }
        }
        finally { await tty.close(); }
    });

    it("rejects a cleared name on the TTY and clears the prefilled role with a dash", async () => {
        const target = agent("Original");
        update(target, { role: "API owner" });
        const tty = terminal();
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 1]"));
            await tty.key("\r");
            await tty.key("\r");
            await tty.key("\u0015");
            await tty.key("\r");
            expect(tty.visible()).toContain("A name must contain 1 to");
            await tty.key("\r");
            expect(tty.visible()).toContain("? Original (Codex)");
            expect(tty.visible()).toMatch(/[>❯] Name/);
            expect(database.prepare("SELECT display_name FROM agent WHERE id = ?").get(target)).toEqual({ display_name: "Original" });
            await tty.key("2");
            await tty.key("\r");
            await tty.key("\u0015");
            await tty.key("-");
            await tty.key("\r");
            expect(tty.visible()).toContain("? Original (Codex)");
            expect(tty.visible()).toMatch(/Role\s+none/);
            expect(database.prepare("SELECT role FROM agent WHERE id = ?").get(target)).toEqual({ role: "" });
        }
        finally { await tty.close(); }
    });

    it.each([false, true])("refreshes and stays in the detail after sending or cancelling (cancel=%s)", async (cancel) => {
        const target = agent("Original");
        const output = await board("Original\nsay\nback\nback\n", async (id) => {
            expect(id).toBe(target);
            store.setNameFromBoard(target, "Current name");
            if(cancel == true) {
                throw new PromptBackError();
            }
        });
        expect(output).toContain("? Current name (Codex)");
        expect(output).toContain("Current name · its next join may set it back");
        expect(output.match(/\? Waiting room/g)).toHaveLength(2);
    });

    it("counts all retained messages and only the viewer's unread receipts, including ones outside the page", async () => {
        const reporter = agent("Reporter");
        const reader = agent("Reader");
        const person = store.ensureHumanParticipant("main", os.userInfo().username);
        const otherPerson = store.ensureHumanParticipant("main", "Another person");
        const older = send(reporter, person, "Only outside the latest page");
        send(reporter, otherPerson, "Someone else's inbox");
        for(let index = 0; index < 55; index += 1) {
            send(reporter, reader, `Recent message ${index}`);
        }
        const newest = send(reporter, [person, reader], "Newest message for both recipients");
        database.exec("PRAGMA query_only = ON");
        try {
            expect(store.getRoomOverview("main", 0)).toMatchObject({ messages: [], message_count: 58 });
            const overview = store.getRoomOverview("main", 50);
            expect(overview.message_count).toBe(58);
            expect(overview.messages).toHaveLength(50);
            expect(overview.messages.some((message) => message.id == older)).toBe(false);
        }
        finally {
            database.exec("PRAGMA query_only = OFF");
        }
        const output = await board(`messages\n#${newest}\nback\nback\n`);
        expect(output).toContain("[Messages 58 · 2 for you]");
        expect(output).toContain("Showing 50 of 58 messages");
        expect(output).toContain("[Messages 58 · 1 for you]");
        expect(output).not.toContain("Only outside the latest page");
        expect(store.pendingFor(person).map((message) => message.id)).toEqual([older]);
        expect(store.pendingFor(reader).some((message) => message.id == newest)).toBe(true);
        expect(store.pendingFor(otherPerson)).toHaveLength(1);
    });

    it("adds paths only to project headings whose names collide", async () => {
        agent("Unique", path.join("one", "npm.concos"));
        agent("First", path.join("one", "shared"));
        agent("Second", path.join("two", "shared"));
        const output = await board("back\n");
        expect(output).toContain("  npm.concos\n");
        expect(output).not.toContain(path.join(directory, "one", "npm.concos"));
        expect(output).toContain(`shared  ${path.join(directory, "one", "shared")}`);
        expect(output).toContain(`shared  ${path.join(directory, "two", "shared")}`);
    });

    it("reads 30 minute bins from messages and checkpoints, and counts five-minute activity without writes", () => {
        const reporter = agent("Reporter");
        const boundary = agent("At five minutes");
        const old = agent("Older");
        const future = agent("Future");
        const never = agent("Never");
        const human = store.ensureHumanParticipant("main", os.userInfo().username);
        const now = Date.parse("2026-10-27T09:30:45.123Z");
        const minute = 60000;
        for(const offset of [-30 * minute - 1, -30 * minute, -29 * minute - 1, -29 * minute, -minute, 0, 1]) {
            const id = send(reporter, "all", `At ${offset}`);
            database.prepare("UPDATE message SET created_at = ? WHERE id = ?").run(new Date(now + offset).toISOString(), id);
        }
        for(const offset of [-31 * minute, -minute]) {
            store.checkIn(reporter, { update: {}, receivedMessageIds: [], checkpoint: `Checkpoint ${offset}`, cursor: null, expectedRevision: null });
            database.prepare("UPDATE checkpoint SET created_at = ? WHERE id = (SELECT MAX(id) FROM checkpoint)").run(new Date(now + offset).toISOString());
        }
        update(reporter, { status: "waiting", task: "This card update is not a sparkline event" });
        for(const [id, offset] of [[reporter, 0], [boundary, -5 * minute], [old, -5 * minute - 1], [future, 1], [human, 0]] as const) {
            const timestamp = new Date(now + offset).toISOString();
            database.prepare("UPDATE agent SET last_call_at = ?, last_seen_at = ? WHERE id = ?").run(timestamp, timestamp, id);
        }
        database.prepare("UPDATE agent SET last_call_at = NULL WHERE id = ?").run(never);
        const clock = vi.spyOn(Date, "now").mockReturnValue(now);
        database.exec("PRAGMA query_only = ON");
        try {
            const overview = store.getRoomOverview("main", 0);
            const bins = Array<number>(30).fill(0);
            bins[0] = 2;
            bins[1] = 1;
            bins[29] = 3;
            expect(overview.activity).toEqual({ events_per_minute: bins, active_agent_count: 2 });
            expect(overview.messages).toEqual([]);
            clock.mockReturnValue(now + minute);
            const refreshed = store.getRoomOverview("main", 50).activity;
            expect(refreshed.events_per_minute[0]).toBe(1);
            expect(refreshed.events_per_minute[28]).toBe(2);
            expect(refreshed.events_per_minute[29]).toBe(2);
            expect(refreshed.active_agent_count).toBe(2);
        }
        finally {
            database.exec("PRAGMA query_only = OFF");
        }
    });

    it("counts only live non-human cards as recently active, excluding recent session ends and leaves", async () => {
        const live = agent("Live");
        const ended = agent("Ended");
        const left = agent("Left");
        const person = store.ensureHumanParticipant("main", os.userInfo().username);
        store.leave(left, { summary: null, nextStep: null, checkpoint: null });
        const now = new Date().toISOString();
        for(const id of [live, ended, left, person]) {
            database.prepare("UPDATE agent SET last_call_at = ?, last_seen_at = ? WHERE id = ?").run(now, now, id);
        }
        database.prepare("UPDATE agent SET disconnected_at = ? WHERE id = ?").run(now, ended);
        database.exec("PRAGMA query_only = ON");
        try {
            const overview = store.getRoomOverview("main", 0);
            expect(overview.agents.find((card) => card.agent_id == ended)?.ended).toBe(true);
            expect(overview.agents.find((card) => card.agent_id == left)?.left).toBe(true);
            expect(overview.activity.active_agent_count).toBe(1);
        }
        finally { database.exec("PRAGMA query_only = OFF"); }
        const output = await board("back\n");
        expect(output).toContain("[Agents 1]");
        expect(output).toContain("last 30m · 1 active in 5m");
    });

    it("summarizes live issue types and distinct normalized edit overlaps within each workspace", async () => {
        const first = agent("First");
        const second = agent("Second");
        const other = agent("Other", "another-project");
        const ended = agent("Ended");
        update(first, { editing: ["src/../src/room-store.ts", "src/room-store.ts", "src", "only-here.ts"] });
        update(second, { editing: [path.join(directory, "project", "src", "room-store.ts"), "src/child.ts"] });
        update(other, { editing: ["only-here.ts"] });
        store.leave(ended, { summary: null, nextStep: null, checkpoint: null });
        const original = RoomStore.prototype.getRoomOverview;
        vi.spyOn(RoomStore.prototype, "getRoomOverview").mockImplementation(function(this: RoomStore, room, limit) {
            const result = original.call(this, room, limit);
            for(const card of result.agents) {
                if(card.agent_id == first || card.agent_id == ended) {
                    card.issues = [
                        { kind: "old_concos", version: "0.1.0" }, { kind: "stuck", since: card.updated_at },
                        { kind: "duplicate", newer_agent_id: second }, { kind: "unread_unwoken", count: 3, since: card.updated_at },
                    ];
                }
            }
            return result;
        });
        const output = await board("back\n");
        expect(output).toMatch(/[▁-█]{30}  last 30m · \d+ active in 5m/);
        expect(output).toContain("! 1 on old concos · 1 stuck · 1 duplicate · 1 unwoken · 1 edit overlap");
        expect(output).not.toContain("2 edit overlaps");
        expect(output).not.toContain("2 on old concos");
    });

    it("aligns only the latest folder after names and unread counts in compact and detail headers, fitting CJK paths", async () => {
        const short = agent("A");
        const long = agent("Longest name");
        const reported = agent("Reported");
        update(reported, { currentDirectory: path.join(directory, "project", "docs") });
        send(long, short);
        database.prepare("UPDATE agent SET recent_folder_list = ?, editing_list = ? WHERE id = ?")
            .run(JSON.stringify([{ path: "src/cli", at: new Date().toISOString() }, { path: "src/db", at: new Date().toISOString() }, { path: "docs", at: new Date().toISOString() }]), '["src/cli/menu.ts"]', short);
        database.prepare("UPDATE agent SET recent_folder_list = ? WHERE id = ?")
            .run(JSON.stringify([{ path: "tests", at: new Date().toISOString() }]), long);
        const output = await board("compact\ncompact\nA\nback\nback\n");
        const views = output.split("? Waiting room").slice(1);
        for(const view of views.slice(0, 3)) {
            const shortLine = view.split("\n").find((line) => line.includes("A (Codex)"))!;
            const longLine = view.split("\n").find((line) => line.includes("Longest name (Codex)"))!;
            expect(shortLine).toContain("(1 unread)");
            expect(shortLine).toContain("src/cli");
            expect(shortLine).not.toContain("src/db");
            expect(shortLine).not.toMatch(/\+\d/);
            expect(shortLine.indexOf("src/cli")).toBe(longLine.indexOf("tests"));
            expect(view).not.toMatch(/\n +Folder/);
        }
        const detail = output.split("? A (Codex)")[1];
        expect(detail).toMatch(/A \(Codex\) \(1 unread\) +src\/cli/);
        expect(output).toMatch(/Reported \(Codex\) +docs \(reported\)/);
        const card = store.getRoomOverview("main", 0).agents.find((entry) => entry.agent_id == short)!;
        card.recent_folders = [{ path: "프로젝트/아주긴경로/화면", at: "unused" }, { path: "tests", at: "unused" }, { path: "docs", at: "unused" }];
        for(const unicode of [false, true]) {
            for(const width of [4, 12, 24, 40]) {
                const location = agentLocation(card, width, unicode, true);
                expect(displayWidth(location.paths.join(" · "))).toBeLessThanOrEqual(width);
                expect(location.paths).toHaveLength(1);
                if(width >= 12) expect(location.paths[0]).toMatch(/화면$/);
            }
        }
        expect(store.getRoomOverview("main", 0).agents.find((entry) => entry.agent_id == reported)?.recent_folders).toEqual([]);
    });

    it.each([false, true])("hides a reported project root and labels an actual root edit in every view (edited=%s)", async (edited) => {
        const target = agent("Root card");
        if(edited) {
            database.prepare("UPDATE agent SET recent_folder_list = ? WHERE id = ?")
                .run(JSON.stringify([{ path: ".", at: new Date().toISOString() }]), target);
        }
        const output = await board("compact\ncompact\nRoot card\nback\nback\n");
        expect(output).not.toContain(". (reported)");
        if(edited) {
            const views = output.split("? Waiting room").slice(1);
            for(const view of views.slice(0, 3)) expect(view).toMatch(/Root card \(Codex\) +\(root\)/);
            expect(output.split("? Root card (Codex)")[1]).toMatch(/Root card \(Codex\) +\(root\)/);
        }
        else {
            expect(output).not.toContain("(reported)");
            expect(output).not.toContain("(root)");
        }
    });

    it("shortens whole leading folders and shows only the newest location at every width", () => {
        expect(shortenPath("src/modules/cli", 15, true)).toBe("src/modules/cli");
        expect(shortenPath("src/modules/cli", 14, true)).toBe("…/modules/cli");
        expect(shortenPath("src/modules/cli", 12, true)).toBe("…/cli");
        expect(shortenPath("src/modules/cli", 4, true)).toBe("cli");
        expect(shortenPath("src/modules/cli", 2, true)).toBe("c…");
        expect(shortenPath("src\\modules\\cli", 14, false)).toBe(".../cli");
        expect(shortenPath("src/modules/cli", 6, false)).toBe("cli");
        const target = agent("Latest first");
        const card = store.getRoomOverview("main", 0).agents.find((entry) => entry.agent_id == target)!;
        card.recent_folders = ["src/modules/cli", "src/modules/store", "tests"].map((folder) => ({ path: folder, at: "unused" }));
        expect(agentLocation(card, 43, true, true)).toMatchObject({ paths: ["src/modules/cli"] });
        expect(agentLocation(card, 14, true, true)).toMatchObject({ paths: ["…/modules/cli"] });
        expect(agentLocation(card, 8, true, true)).toMatchObject({ paths: ["…/cli"] });
    });

    it("separates the detail header and body and renders each recent folder with its own age", () => {
        const target = agent("Location owner");
        update(target, { role: "Standing responsibility", task: "Current task", nextStep: "Next action", blocker: "Dependency", editing: ["tests/a.ts"], summary: "Current summary", references: ["README.md"] });
        store.checkIn(target, { update: {}, checkpoint: "Verified the renderer", cursor: null, expectedRevision: null, receivedMessageIds: [] });
        const card = store.getRoomOverview("main", 0).agents.find((entry) => entry.agent_id == target)!;
        card.issues = [{ kind: "old_concos", version: "0.1.0" }];
        const now = Date.now();
        card.recent_folders = [
            { path: "tests", at: new Date(now).toISOString() },
            { path: "src/modules/cli", at: new Date(now - 60000).toISOString() },
            { path: ".", at: new Date(now - 9 * 60000).toISOString() },
        ];
        const detail = store.inspectAgent(target, { agentId: target, checkpointLimit: 3, beforeCheckpointId: null });
        const options = { language: "en" as const, nowMs: now, columns: 100 };
        const header = renderAgentDetailHeader(card, detail, options);
        const body = renderAgentDetailBody(card, detail, options);
        expect(header).toMatch(/Location owner \(Codex\) +tests/);
        expect(header).not.toContain("src/modules/cli");
        expect(header).not.toContain("Current task");
        expect(body).not.toContain("Standing responsibility");
        expect(body).not.toContain("Waiting messages");
        expect(body).not.toContain("Recent folders");
        const labels = ["Check", "Task", "Next", "Blocker", "Editing", "Summary", "References", "Checkpoints"];
        expect(labels.map((label) => body.indexOf(label))).toEqual([...labels.map((label) => body.indexOf(label))].sort((left, right) => left - right));
        expect(recentFolderLines(card, options)).toEqual([
            { text: "tests  just now", tone: "plain" },
            { text: "src/modules/cli  1m ago", tone: "dim" },
            { text: "(root)  9m ago", tone: "dim" },
        ]);
        card.recent_folders[1].path = "프로젝트/아주긴컴포넌트경로/설정화면".repeat(4);
        for(const columns of [54, 80, 100]) {
            for(const unicode of [false, true]) {
                const rows = recentFolderLines(card, { ...options, columns, unicode });
                expect(rows).toHaveLength(3);
                for(const row of rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(columns - 1);
                expect(rows[1].text).toMatch(/  1m ago$/);
            }
        }
        expect(recentFolderLines({ ...card, editing: [] }, options)[0].tone).toBe("dim");
        expect(recentFolderLines({ ...card, recent_folders: [] }, options)).toEqual([]);
    });

    it("gives the newest folder room before the report age in a narrow normal card", async () => {
        const target = agent("CC:X CONCOS2");
        const peer = agent("CC:D CONCOS9");
        send(target, peer);
        database.prepare("UPDATE agent SET recent_folder_list = ? WHERE id = ?")
            .run(JSON.stringify(["src/new-location", "src/modules/cli", "src/modules/store"].map((folder) => ({ path: folder, at: new Date().toISOString() }))), target);
        const tty = terminal(54, 24);
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 2]"));
            const row = tty.screen.visible().find((line) => line.includes("CC:X CONCOS2"));
            expect(row).toMatch(/(?:src|…)\/new-location/);
            expect(row).not.toMatch(/\+\d/);
            expect(row).not.toContain("just now");
        }
        finally { await tty.close(); }
    });

    it("refreshes recent locations inside an open detail without moving the selected action or receiving messages", async () => {
        const target = agent("Target");
        const reporter = agent("Reporter");
        const id = send(reporter, target);
        const tty = terminal(100, 34);
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 2]"));
            await tty.key("\u001b[B");
            await tty.key("\r");
            expect(tty.visible()).toContain("? Target (Codex)");
            expect(tty.visible()).toMatch(/[>❯] Name/);
            database.prepare("UPDATE agent SET recent_folder_list = ?, editing_list = ? WHERE id = ?")
                .run(JSON.stringify([{ path: "src/fresh", at: new Date().toISOString() }]), '["src/fresh/file.ts"]', target);
            await vi.waitFor(() => expect(tty.visible()).toMatch(/Target \(Codex\) \(1 unread\) +src\/fresh/), { timeout: 2000 });
            expect(tty.visible()).toMatch(/[>❯] Name/);
            expect(tty.visible()).not.toContain("UPDATED");
            expect(database.prepare("SELECT received_at, delivered_at FROM message_receipt WHERE message_id = ? AND agent_id = ?").get(id, target))
                .toEqual({ received_at: null, delivered_at: null });
        }
        finally { await tty.close(); }
    });

    it("toggles compact cards in fixed name order, keeping state, name, unread and task on one row", async () => {
        const zed = agent("Zed");
        const alpha = agent("Alpha");
        update(zed, { status: "working", task: "Zed task", nextStep: "Zed next step", blocker: "Dependency" });
        update(alpha, { status: "working", task: "Alpha task", nextStep: "Alpha next step", role: "API owner" });
        send(zed, alpha);
        const output = await board("compact\ncompact\nback\n");
        const views = output.split("? Waiting room").slice(1);
        expect(views).toHaveLength(3);
        expect(views[0]).toContain("Role");
        expect(views[0]).toContain("Next");
        expect(views[1]).toMatch(/working +Alpha \(Codex\) \(1 unread\) · Alpha task/);
        expect(views[1]).toMatch(/blocked +Zed \(Codex\) · Zed task/);
        expect(views[1]).not.toContain("API owner");
        expect(views[1]).not.toContain("Alpha next step");
        expect(views[2]).toContain("API owner");
        for(const view of views) expect(view.indexOf("Alpha (Codex)")).toBeLessThan(view.indexOf("Zed (Codex)"));
    });

    it("leaves unread-only warnings out of both the bulk count and the cards taken down", async () => {
        const waiting = agent("Waiting");
        const mixed = agent("Mixed");
        const overview = RoomStore.prototype.getRoomOverview;
        const unwoken: AgentIssue = { kind: "unread_unwoken", count: 1, since: new Date(Date.now() - 25 * 60_000).toISOString() };
        vi.spyOn(RoomStore.prototype, "getRoomOverview").mockImplementation(function(this: RoomStore, room, limit) {
            const result = overview.call(this, room, limit);
            for(const card of result.agents) {
                if(card.agent_id == waiting) card.issues = [unwoken];
                if(card.agent_id == mixed) card.issues = [unwoken, { kind: "old_concos", version: "0.1.0" }];
            }
            return result;
        });
        const output = await board("retire\ny\nback\n");
        expect(output).toContain("Take down flagged cards (1)");
        expect(output).toContain("type in the session");
        expect(output).toContain("Take down Mixed (Codex)?");
        expect(database.prepare("SELECT left_at FROM agent WHERE id = ?").get(waiting)).toEqual({ left_at: null });
        expect(database.prepare("SELECT left_at FROM agent WHERE id = ?").get(mixed)).toEqual({ left_at: expect.any(String) });
    });

    it("keeps the topic and query ready to edit after Search again in line mode", async () => {
        send(agent("Reporter"), "all");
        const input = Readable.from(["topic\nconcos_dev\nback\nESC\nback\n"]);
        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => { text += chunk.toString(); });
        const prompter = new Prompter(input, output);
        try { await showMessageSearch(prompter, store, { language: "en", columns: 80 }); }
        finally { prompter.close(); }
        expect(text).toContain("Message search · concos_dev · 1 result");
        expect(text).toContain("? Topic key (concos_dev)");
        expect(text.match(/\? Search messages by/g)).toHaveLength(2);
    });

    it("returns Search again to the populated search row with its cursor at 80 columns", async () => {
        send(agent("Reporter"), "all", "The cart service needs review");
        const tty = terminal();
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 1]"));
            await tty.key("\t");
            await vi.waitFor(() => expect(tty.visible()).toContain("[Messages 1 · 0 for you]"));
            await tty.key("\u001b[H");
            expect(tty.visible()).toContain("Enter: topic/sender");
            await tty.key("cart");
            await tty.key("\r");
            await vi.waitFor(() => expect(tty.visible()).toContain("Message search · cart · 1 result"));
            await tty.key("\u001b[F");
            await tty.key("\r");
            await vi.waitFor(() => {
                const row = tty.screen.visible().find((line) => line.includes("Search messages"));
                expect(row).toMatch(/[❯>] Search messages +cart[▏_]/);
            });
            await tty.key("\r");
            await vi.waitFor(() => expect(tty.visible()).toContain("Message search · cart · 1 result"));
        }
        finally { await tty.close(); }
    });

    it.each(["agent", "message"])("scrolls a long %s detail and restores the board heading and selection twice", async (kind) => {
        const reporter = agent("Reporter");
        const text = Array.from({ length: 60 }, (_, index) => `Review line ${String(index + 1).padStart(2, "0")} with complete details`).join("\n");
        if(kind == "agent") update(reporter, { summary: text });
        else send(reporter, "all", text);
        const tty = terminal();
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 1]"));
            if(kind == "message") await tty.key("\t");
            await vi.waitFor(() => expect(tty.visible()).toContain(kind == "agent" ? "[Agents 1]" : "[Messages 1 · 0 for you]"));
            const before = tty.screen.visible().findIndex((line) => line.includes("? Waiting room"));
            for(let pass = 0; pass < 2; pass += 1) {
                await tty.key("\r");
                await vi.waitFor(() => expect(tty.visible()).toContain("Review line 01"));
                for(let page = 0; page < 12; page += 1) await tty.key("\u001b[6~");
                await vi.waitFor(() => expect(tty.visible()).toContain("Review line 60"));
                expect(tty.visible()).toContain(kind == "agent" ? "Enter returns to menu" : "Back");
                await tty.key("\u001b");
                await vi.waitFor(() => expect(tty.visible()).toContain("? Waiting room"));
                expect(tty.screen.visible().findIndex((line) => line.includes("? Waiting room"))).toBe(before);
                const selected = tty.screen.visible().find((line) => /^[❯>]/.test(line));
                expect(selected).toContain(kind == "agent" ? "Reporter (Codex)" : "QUESTION");
            }
        }
        finally { await tty.close(); }
    });

    it("keeps a reported subfolder and unread count in a compact card at 54 columns", async () => {
        const reader = agent("A fairly long agent name");
        const reporter = agent("Reporter");
        update(reader, { task: "Review checkout", nextStep: "Long next step hidden in compact view" });
        update(reader, { currentDirectory: path.join(directory, "project", "src", "checkout") });
        send(reporter, reader);
        const tty = terminal(54, 20);
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 2]"));
            expect(tty.visible()).toContain("last 30m · 2 active in 5m");
            await tty.key("1");
            await tty.key("\r");
            await vi.waitFor(() => expect(tty.visible()).toMatch(/Compact view +on/));
            expect(tty.screen.visible().find((line) => line.includes("(1 unread)"))).toMatch(/A fairly.*\(1 unread\).*\(reported\)/);
            expect(tty.visible()).not.toContain("Long next step");
        }
        finally { await tty.close(); }
    });
});
