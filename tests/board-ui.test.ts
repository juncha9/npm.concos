import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showRoomBoard } from "../src/modules/cli/room-board";
import type { RoomBoardOptions } from "../src/modules/cli/room-board";
import { showMessageSearch } from "../src/modules/cli/message-search";
import { Prompter, PromptClosedError } from "../src/modules/cli/prompter";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";
import type { AgentIssue } from "../src/modules/store/room-store";
import { TerminalScreen } from "./terminal-screen";

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
            await vi.waitFor(() => expect(tty.visible()).toContain("[Messages 1]"));
            await tty.key("\u001b[H");
            await tty.key("\u001b[B");
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
            await vi.waitFor(() => expect(tty.visible()).toContain(kind == "agent" ? "[Agents 1]" : "[Messages 1]"));
            const before = tty.screen.visible().findIndex((line) => line.includes("? Waiting room"));
            for(let pass = 0; pass < 2; pass += 1) {
                await tty.key("\r");
                await vi.waitFor(() => expect(tty.visible()).toContain("Review line 01"));
                for(let page = 0; page < 12; page += 1) await tty.key("\u001b[6~");
                await vi.waitFor(() => expect(tty.visible()).toContain("Review line 60"));
                expect(tty.visible()).toContain("Back");
                await tty.key("\u001b");
                await vi.waitFor(() => expect(tty.visible()).toContain("? Waiting room"));
                expect(tty.screen.visible().findIndex((line) => line.includes("? Waiting room"))).toBe(before);
                const selected = tty.screen.visible().find((line) => /^[❯>]/.test(line));
                expect(selected).toContain(kind == "agent" ? "Reporter (Codex)" : "QUESTION");
            }
        }
        finally { await tty.close(); }
    });

    it("shows the task and unread count in a compact card at 54 columns", async () => {
        const reader = agent("A fairly long agent name");
        const reporter = agent("Reporter");
        update(reader, { task: "Review checkout", nextStep: "Long next step hidden in compact view" });
        send(reporter, reader);
        const tty = terminal(54, 20);
        try {
            await vi.waitFor(() => expect(tty.visible()).toContain("[Agents 2]"));
            await tty.key("\u001b[F");
            await tty.key("\u001b[A");
            await tty.key("\r");
            await vi.waitFor(() => expect(tty.visible()).toMatch(/Compact view +on/));
            expect(tty.screen.visible().find((line) => line.includes("(1 unread)"))).toMatch(/A fairly.*\(1 unread\).*Review checkout/);
            expect(tty.visible()).not.toContain("Long next step");
        }
        finally { await tty.close(); }
    });
});
