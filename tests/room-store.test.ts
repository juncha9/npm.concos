import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHECK_IN_MAX_CHARS, MESSAGE_PREVIEW_LENGTH } from "../src/_defs";
import { openDatabase } from "../src/modules/store/database";
import { RoomError } from "../src/modules/store/room-error";
import { RoomStore } from "../src/modules/store/room-store";

let dataDirectory: string;
let workDirectory: string;
let database: DatabaseSync;
let store: RoomStore;

beforeEach(async () => {
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-test-"));
    workDirectory = path.join(dataDirectory, "work");
    fs.mkdirSync(workDirectory);
    database = await openDatabase(dataDirectory);
    store = new RoomStore(database);
});

afterEach(() => {
    database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
});

function joinAgent(name: string, room = "dev", directory = workDirectory) {
    return store.join({
        room: room,
        displayName: name,
        client: "test",
        workingDirectory: directory,
        workspaceRoot: null,
        resumeHandle: null,
    });
}

function emptyCheckIn(agentId: string, overrides: Partial<Parameters<RoomStore["checkIn"]>[1]> = {}) {
    return store.checkIn(agentId, {
        cursor: null,
        expectedRevision: null,
        update: {},
        checkpoint: null,
        receivedMessageIds: [],
        ...overrides,
    });
}

describe("join", () => {
    it("gives two sessions in the same folder separate agents and one workspace", () => {
        const first = joinAgent("ui");
        const second = joinAgent("server");
        expect(first.agent_id).not.toBe(second.agent_id);
        expect(first.handle).not.toBe(second.handle);
        expect(first.workspace_id).toBe(second.workspace_id);
    });

    it("keeps same-named folders at different paths apart", () => {
        const otherParent = path.join(dataDirectory, "other");
        const sameName = path.join(otherParent, "work");
        fs.mkdirSync(sameName, { recursive: true });
        const first = joinAgent("a");
        const second = joinAgent("b", "dev", sameName);
        expect(first.workspace_id).not.toBe(second.workspace_id);
    });

    it("rejects a relative working directory", () => {
        expect(() => joinAgent("a", "dev", "relative/path")).toThrow(RoomError);
    });

    it("comes back as the same agent with resume_handle", () => {
        const first = joinAgent("ui");
        store.leave(first.agent_id, { summary: null, nextStep: null, checkpoint: null });
        const resumed = store.join({
            room: "dev",
            displayName: "ui",
            client: "test",
            workingDirectory: workDirectory,
            workspaceRoot: null,
            resumeHandle: first.handle,
        });
        expect(resumed.agent_id).toBe(first.agent_id);
        expect(resumed.resumed).toBe(true);
    });
});

describe("check_in", () => {
    it("shows another agent's change once, and answers briefly when nothing changed", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        emptyCheckIn(ui.agent_id);

        emptyCheckIn(server.agent_id, { update: { task: "message storage", editing: ["src/messages.ts"] } });
        const seen = emptyCheckIn(ui.agent_id);
        expect(seen.changed).toBe(true);
        expect(seen.agents).toEqual([
            expect.objectContaining({ agent_id: server.agent_id, task: "message storage", editing: ["src/messages.ts"] }),
        ]);

        const again = emptyCheckIn(ui.agent_id);
        expect(again).toEqual({ changed: false, pending_count: 0, cursor: again.cursor, revision: again.revision });
    });

    it("does not echo an agent's own change back to it", () => {
        const ui = joinAgent("ui");
        const result = emptyCheckIn(ui.agent_id, { update: { task: "layout" } });
        expect(result.agents).toBeUndefined();
    });

    it("re-delivers when a previous cursor is repeated", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const before = emptyCheckIn(ui.agent_id);
        emptyCheckIn(server.agent_id, { update: { task: "x" } });
        const first = emptyCheckIn(ui.agent_id);
        const retried = emptyCheckIn(ui.agent_id, { cursor: before.cursor });
        expect(retried.agents).toEqual(first.agents);
    });

    it("rejects a stale expected_revision without applying anything", () => {
        const ui = joinAgent("ui");
        const updated = emptyCheckIn(ui.agent_id, { update: { task: "first" } });
        expect(() => emptyCheckIn(ui.agent_id, {
            expectedRevision: updated.revision - 1,
            update: { task: "late write" },
        })).toThrow(/revision conflict/);
        const card = store.inspectAgent(ui.agent_id, { agentId: ui.agent_id, checkpointLimit: null, beforeCheckpointId: null });
        expect(card.card.task).toBe("first");
    });

    it("pages many changes without losing any, within the size limit", () => {
        const viewer = joinAgent("viewer");
        emptyCheckIn(viewer.agent_id);
        const others = ["a", "b", "c", "d", "e"].map((name) => joinAgent(name));
        for(const other of others) {
            emptyCheckIn(other.agent_id, { update: { task: "t".repeat(110), nextStep: "n".repeat(110) } });
        }

        const seenIds: string[] = [];
        let page = emptyCheckIn(viewer.agent_id);
        for(let guard = 0; guard < 10; guard++) {
            expect(JSON.stringify(page).length).toBeLessThanOrEqual(CHECK_IN_MAX_CHARS);
            seenIds.push(...(page.agents ?? []).map((card) => card.agent_id));
            if(page.has_more != true) {
                break;
            }
            page = emptyCheckIn(viewer.agent_id);
        }
        expect(new Set(seenIds)).toEqual(new Set(others.map((other) => other.agent_id)));
    });
});

describe("messages", () => {
    it("delivers a preview, counts it pending until acknowledged", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        emptyCheckIn(server.agent_id);

        const sent = store.sendMessage(ui.agent_id, { to: server.agent_id, kind: "question", text: "need message_id", replyTo: null, requestId: null });
        expect(sent.recipient_count).toBe(1);

        const received = emptyCheckIn(server.agent_id);
        expect(received.pending_count).toBe(1);
        expect(received.messages).toEqual([
            expect.objectContaining({ id: sent.message_id, from: ui.agent_id, to: "me", kind: "question", text: "need message_id" }),
        ]);

        const acknowledged = emptyCheckIn(server.agent_id, { receivedMessageIds: [sent.message_id] });
        expect(acknowledged.pending_count).toBe(0);
        expect(store.readMessages(server.agent_id, { messageIds: null, limit: null }).messages).toEqual([]);
    });

    it("truncates a long message in check_in and returns it whole from read_messages", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const longText = "x".repeat(MESSAGE_PREVIEW_LENGTH * 3);
        const sent = store.sendMessage(ui.agent_id, { to: server.agent_id, kind: "note", text: longText, replyTo: null, requestId: null });

        const received = emptyCheckIn(server.agent_id);
        const preview = received.messages?.find((message) => message.id == sent.message_id);
        expect(preview?.truncated).toBe(true);
        expect(preview?.text.length).toBe(MESSAGE_PREVIEW_LENGTH);

        const full = store.readMessages(server.agent_id, { messageIds: [sent.message_id], limit: null });
        expect(full.messages[0].text).toBe(longText);
        expect(full.messages[0].received).toBe(false);
    });

    it("stores a retried send once", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const input = { to: server.agent_id, kind: "note" as const, text: "hi", replyTo: null, requestId: "req-1" };
        const first = store.sendMessage(ui.agent_id, input);
        const retry = store.sendMessage(ui.agent_id, input);
        expect(retry.message_id).toBe(first.message_id);
        expect(retry.duplicate).toBe(true);
        expect(emptyCheckIn(server.agent_id).pending_count).toBe(1);
    });

    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60_000).toISOString();
    const receivedIds = (agentId: string) => (database.prepare("SELECT message_id FROM message_receipt WHERE agent_id = :id ORDER BY message_id")
        .all({ id: agentId }) as { message_id: number }[]).map((row) => row.message_id);
    const notice = (from: string, text: string) => store.sendMessage(from, { to: "all", kind: "notice", text: text, replyTo: null, requestId: null }).message_id;

    it("gives a room-wide message to everyone present, and to a session joining within four hours", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const sent = store.sendMessage(ui.agent_id, { to: "all", kind: "notice", text: "schema frozen", replyTo: null, requestId: null });
        expect(sent.recipient_count).toBe(1);
        const late = joinAgent("late");
        expect(emptyCheckIn(late.agent_id).pending_count).toBe(1);
        expect(emptyCheckIn(server.agent_id).pending_count).toBe(1);
        database.prepare("UPDATE message SET created_at = :at WHERE id = :id").run({ at: hoursAgo(5), id: sent.message_id });
        expect(emptyCheckIn(joinAgent("later").agent_id).pending_count).toBe(0);
    });

    it("gives a new session at most the five newest room-wide messages", () => {
        const ui = joinAgent("ui");
        const ids = Array.from({ length: 7 }, (_, index) => notice(ui.agent_id, `notice ${index}`));
        expect(receivedIds(joinAgent("late").agent_id)).toEqual(ids.slice(-5));
    });

    it("gives a returning session the room-wide messages it missed within a day, not its own", () => {
        const ui = joinAgent("ui");
        const away = joinAgent("away");
        const mine = notice(away.agent_id, "from me");
        store.disconnect([away.agent_id]);
        // the card is days old, so the day-long lifetime is what limits the catch-up
        database.prepare("UPDATE agent SET joined_at = :at WHERE id = :id").run({ at: hoursAgo(72), id: away.agent_id });
        const stale = notice(ui.agent_id, "old news");
        database.prepare("UPDATE message SET created_at = :at WHERE id = :id").run({ at: hoursAgo(25), id: stale });
        const missed = notice(ui.agent_id, "while you were away");
        store.join({ room: "dev", displayName: "away", client: "test", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: away.handle });
        expect(receivedIds(away.agent_id)).toEqual([missed]);
        expect(receivedIds(away.agent_id)).not.toContain(mine);
    });

    it("shares the waiting room across former room names and still requires reply_to", () => {
        const ui = joinAgent("ui");
        const outsider = joinAgent("outsider", "other-room");
        expect(store.sendMessage(ui.agent_id, { to: outsider.agent_id, kind: "note", text: "hi", replyTo: null, requestId: null }).recipient_count).toBe(1);
        expect(() => store.sendMessage(ui.agent_id, { to: "all", kind: "reply", text: "ok", replyTo: null, requestId: null })).toThrow(/reply_to/);
    });
});

describe("topics and several recipients", () => {
    function send(from: string, to: string | string[], topics: string[] = [], text = "hello") {
        return store.sendMessage(from, { to: to, kind: "note", text: text, replyTo: null, requestId: null, topics: topics });
    }

    it("files a message under canonical topic keys in the order given, and rejects keys that do not read as one", () => {
        const sender = joinAgent("sender");
        const reader = joinAgent("reader");
        const sent = send(sender.agent_id, reader.agent_id, ["Webapp login-redirect", "concos_board", "concos board"]);
        const read = store.readMessages(reader.agent_id, { messageIds: [sent.message_id], limit: null });
        expect(read.messages[0].topics).toEqual(["webapp_login_redirect", "concos_board"]);

        expect(() => send(sender.agent_id, reader.agent_id, ["board"])).toThrow(/2-6 lowercase English words/);
        expect(() => send(sender.agent_id, reader.agent_id, ["보드_탭"])).toThrow(/2-6 lowercase English words/);
        expect(() => send(sender.agent_id, reader.agent_id, ["aa_one", "aa_two", "aa_three", "aa_four"])).toThrow(/at most 3 topics/);
        expect(database.prepare("SELECT COUNT(*) AS n FROM message").get()).toMatchObject({ n: 1 });
    });

    it("points a new topic at similar ones already in use, but not a topic being reused", () => {
        const sender = joinAgent("sender");
        const reader = joinAgent("reader");
        const similarFor = (topic: string) => send(sender.agent_id, reader.agent_id, [topic]).similar_topics;
        expect(send(sender.agent_id, reader.agent_id, ["webapp_login_redirect", "concos_board_layout"]).similar_topics).toBeUndefined();
        // a leading part of another
        expect(similarFor("webapp_login")).toEqual(["webapp_login_redirect"]);
        // the same first word and another shared word
        expect(similarFor("concos_ui_layout")).toEqual(["concos_board_layout"]);
        // the same words in another order
        expect(similarFor("layout_board_concos")).toEqual(["concos_board_layout"]);
        expect(similarFor("concos_release")).toBeUndefined();
        expect(similarFor("webapp_login_redirect")).toBeUndefined();
    });

    it("gives a message for several agents one receipt each and shows it to them as a group message", () => {
        const sender = joinAgent("sender");
        const first = joinAgent("first");
        const second = joinAgent("second");
        const bystander = joinAgent("bystander");
        const sent = send(sender.agent_id, [first.agent_id, second.agent_id], [], "review the schema");
        expect(sent.recipient_count).toBe(2);
        expect(emptyCheckIn(first.agent_id).messages).toEqual([expect.objectContaining({ id: sent.message_id, to: "group" })]);
        expect(emptyCheckIn(second.agent_id).pending_count).toBe(1);
        expect(emptyCheckIn(bystander.agent_id).pending_count).toBe(0);
        const overview = store.getRoomOverview("main", 20).messages.find((message) => message.id == sent.message_id);
        expect(overview?.to_name).toBe("first, second");

        expect(() => send(sender.agent_id, ["all", first.agent_id])).toThrow(/"all" alone/);
        const tooMany = Array.from({ length: 11 }, (_, index) => `agt_${index}`);
        expect(() => send(sender.agent_id, tooMany)).toThrow(/at most 10 recipients/);
    });

    it("reads a topic with its narrower topics, among messages the reader can see, newest page in reading order", () => {
        const sender = joinAgent("sender");
        const reader = joinAgent("reader");
        const outsider = joinAgent("outsider");
        const board = send(sender.agent_id, reader.agent_id, ["concos_board"]).message_id;
        const tabs = send(sender.agent_id, reader.agent_id, ["concos_board_tabs"]).message_id;
        send(sender.agent_id, outsider.agent_id, ["concos_board"]);
        const boardroom = send(sender.agent_id, reader.agent_id, ["concos_boardroom"]).message_id;
        const second = send(sender.agent_id, reader.agent_id, ["concos_release", "concos_board_tabs"]).message_id;
        const ids = (topic: string, limit: number | null = null) => store.readMessages(reader.agent_id, { messageIds: null, limit: limit, topic: topic });

        expect(ids("concos_board").messages.map((message) => message.id)).toEqual([board, tabs, second]);
        const newest = ids("concos_board", 2);
        expect(newest.messages.map((message) => message.id)).toEqual([tabs, second]);
        expect(newest.has_more).toBe(true);
        expect(ids("Concos").messages.map((message) => message.id)).toEqual([board, tabs, boardroom, second]);
        expect(() => ids("보드")).toThrow(RoomError);
    });
});

describe("leaving and disconnecting", () => {
    it("clears the editing claim on leave and shows the agent as left", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        emptyCheckIn(ui.agent_id);
        emptyCheckIn(server.agent_id, { update: { editing: ["src/a.ts"] } });
        emptyCheckIn(ui.agent_id);

        store.leave(server.agent_id, { summary: "done", nextStep: "review", checkpoint: "merged storage" });
        const seen = emptyCheckIn(ui.agent_id);
        expect(seen.agents).toEqual([
            expect.objectContaining({ agent_id: server.agent_id, status: "finished", left: true, checkpoint: "merged storage" }),
        ]);
        expect(seen.agents?.[0].editing).toBeUndefined();
    });

    it("releases the editing claim when the bridge disconnects", () => {
        const server = joinAgent("server");
        emptyCheckIn(server.agent_id, { update: { editing: ["src/a.ts"] } });
        store.disconnect([server.agent_id]);
        const card = store.inspectAgent(server.agent_id, { agentId: server.agent_id, checkpointLimit: null, beforeCheckpointId: null }).card;
        expect(card.editing).toEqual([]);
        expect(card.online).toBe(false);
    });
});

describe("ended sessions", () => {
    // silent past ENDED_AFTER_MS (30 minutes) without anything being closed
    function silence(agentId: string, minutes: number) {
        database.prepare("UPDATE agent SET last_seen_at = :at WHERE id = :id").run({ at: new Date(Date.now() - minutes * 60_000).toISOString(), id: agentId });
    }

    it("leaves closed, silent and human participants out of room-wide messages", () => {
        const sender = joinAgent("sender");
        const active = joinAgent("active");
        const closed = joinAgent("closed");
        const silent = joinAgent("silent");
        const resting = joinAgent("resting");
        store.disconnect([closed.agent_id]);
        silence(silent.agent_id, 31);
        silence(resting.agent_id, 29);
        store.ensureHumanParticipant("main", "Reviewer");

        const sent = store.sendMessage(sender.agent_id, { to: "all", kind: "notice", text: "schema frozen", replyTo: null, requestId: null });
        expect(sent.recipient_count).toBe(2);
        const receivers = database.prepare("SELECT agent_id FROM message_receipt WHERE message_id = :id ORDER BY agent_id")
            .all({ id: sent.message_id }) as { agent_id: string }[];
        expect(receivers.map((row) => row.agent_id).sort()).toEqual([active.agent_id, resting.agent_id].sort());
    });

    it("still stores a direct message to an ended session, and says it is inactive", () => {
        const sender = joinAgent("sender");
        const closed = joinAgent("closed");
        store.disconnect([closed.agent_id]);
        const sent = store.sendMessage(sender.agent_id, { to: closed.agent_id, kind: "note", text: "for when you return", replyTo: null, requestId: null });
        expect(sent).toMatchObject({ recipient_count: 1, inactive_recipients: [closed.agent_id] });
    });

    it("keeps sessions that ended before a newcomer joined out of its check_in, but delivers later endings once", () => {
        const early = joinAgent("early");
        emptyCheckIn(early.agent_id, { update: { task: "finished long ago" } });
        store.disconnect([early.agent_id]);
        // clearly before the newcomer joins, so a shared millisecond cannot blur the order
        const aMinuteAgo = new Date(Date.now() - 60_000).toISOString();
        database.prepare("UPDATE agent SET disconnected_at = :at, last_seen_at = :at WHERE id = :id").run({ at: aMinuteAgo, id: early.agent_id });
        const witness = joinAgent("witness");
        emptyCheckIn(witness.agent_id, { update: { task: "still here" } });

        const newcomer = joinAgent("newcomer");
        const first = emptyCheckIn(newcomer.agent_id);
        expect(first.agents?.map((card) => card.name)).toEqual(["witness"]);

        // ended after the newcomer joined: it saw this agent alive, so the final card comes once
        emptyCheckIn(witness.agent_id, { update: { editing: ["src/a.ts"] } });
        store.disconnect([witness.agent_id]);
        const later = emptyCheckIn(newcomer.agent_id);
        expect(later.agents).toEqual([expect.objectContaining({ name: "witness", offline: true })]);
        expect(emptyCheckIn(newcomer.agent_id).agents).toBeUndefined();
    });

    it("brings a session back on its next call and acknowledges what it was last given", () => {
        const sender = joinAgent("sender");
        const receiver = joinAgent("receiver");
        const sent = store.sendMessage(sender.agent_id, { to: receiver.agent_id, kind: "question", text: "ready?", replyTo: null, requestId: null });
        store.disconnect([receiver.agent_id]);
        expect(store.getRoomOverview("main", 0).agents.find((agent) => agent.agent_id == receiver.agent_id)?.ended).toBe(true);

        store.recordCall(receiver.agent_id, [sent.message_id]);
        const overview = store.getRoomOverview("main", 0).agents.find((agent) => agent.agent_id == receiver.agent_id)!;
        expect(overview).toMatchObject({ ended: false, online: true, pending_count: 0 });
    });

    it("counts a message delivered in this response out of the inbox it returns", () => {
        const sender = joinAgent("sender");
        const receiver = joinAgent("receiver");
        const question = store.sendMessage(sender.agent_id, { to: receiver.agent_id, kind: "question", text: "q", replyTo: null, requestId: null });
        store.sendMessage(sender.agent_id, { to: receiver.agent_id, kind: "note", text: "n", replyTo: null, requestId: null });
        expect(store.getInbox(receiver.agent_id)).toEqual({ questions: 1, notes: 1 });
        expect(store.getInbox(receiver.agent_id, [question.message_id])).toEqual({ questions: 0, notes: 1 });
    });

    it("resolves a reused session name to the live session", () => {
        const old = joinAgent("Dev / API 01");
        store.disconnect([old.agent_id]);
        const current = joinAgent("Dev / API 01");
        expect(store.findAgentInRoom("main", "dev / api 01")).toBe(current.agent_id);
    });
});

describe("resolved messages", () => {
    function messageState(id: number) {
        return store.getRoomOverview("main", 20).messages.find((message) => message.id == id)!;
    }

    it("stays open until every active recipient acknowledged it, and names who it waits on", () => {
        const sender = joinAgent("sender");
        const first = joinAgent("first");
        const second = joinAgent("second");
        const sent = store.sendMessage(sender.agent_id, { to: "all", kind: "notice", text: "deploy at 5", replyTo: null, requestId: null });
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false });
        expect(messageState(sent.message_id).waiting_on.sort()).toEqual(["first", "second"]);

        store.acknowledge(first.agent_id, [sent.message_id]);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["second"] });
        store.acknowledge(second.agent_id, [sent.message_id]);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: true, waiting_on: [] });
    });

    it("does not wait on a connected session idle past half an hour, and waits again once it acts", () => {
        const sender = joinAgent("sender");
        const idle = joinAgent("idle");
        const sent = store.sendMessage(sender.agent_id, { to: idle.agent_id, kind: "note", text: "later", replyTo: null, requestId: null });
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["idle"] });
        // its bridge keeps beating, but the agent itself has not called concos for 31 minutes
        database.prepare("UPDATE agent SET last_call_at = :at WHERE id = :id").run({ at: new Date(Date.now() - 31 * 60_000).toISOString(), id: idle.agent_id });
        store.heartbeat([idle.agent_id]);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: true, waiting_on: [] });
        store.recordCall(idle.agent_id, []);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["idle"] });
    });

    it("does not wait on a recipient whose session ended, and reopens when it comes back", () => {
        const sender = joinAgent("sender");
        const away = joinAgent("away");
        const sent = store.sendMessage(sender.agent_id, { to: away.agent_id, kind: "note", text: "later", replyTo: null, requestId: null });
        store.disconnect([away.agent_id]);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: true });
        store.recordCall(away.agent_id, []);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["away"] });
    });

    it("keeps a message to a person open until they acknowledge it", () => {
        const sender = joinAgent("sender");
        const person = store.ensureHumanParticipant("main", "Reviewer");
        const sent = store.sendMessage(sender.agent_id, { to: person, kind: "note", text: "done", replyTo: null, requestId: null });
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["Reviewer"] });
        store.acknowledge(person, [sent.message_id]);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: true });
    });

    it("takes a person opening a group message as their acknowledgement only", () => {
        const sender = joinAgent("sender");
        const agent = joinAgent("agent");
        const person = store.ensureHumanParticipant("main", "Reviewer");
        const sent = store.sendMessage(sender.agent_id, { to: [person, agent.agent_id], kind: "note", text: "both of you", replyTo: null, requestId: null });
        store.acknowledgeForPerson("Someone else", sent.message_id);
        expect(messageState(sent.message_id).waiting_on.sort()).toEqual(["Reviewer", "agent"]);
        store.acknowledgeForPerson("Reviewer", sent.message_id);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["agent"] });
    });

    it("counts a room-wide message that reached nobody as resolved", () => {
        const alone = joinAgent("alone");
        const sent = store.sendMessage(alone.agent_id, { to: "all", kind: "notice", text: "anyone?", replyTo: null, requestId: null });
        expect(sent.recipient_count).toBe(0);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: true });
    });
});

describe("clean-up", () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    function ageMessage(id: number, minutes: number) {
        database.prepare("UPDATE message SET created_at = :at WHERE id = :id").run({ at: minutesAgo(minutes), id: id });
        database.prepare("UPDATE message_receipt SET received_at = :at WHERE message_id = :id AND received_at IS NOT NULL").run({ at: minutesAgo(minutes), id: id });
    }
    const messageExists = (id: number) => database.prepare("SELECT id FROM message WHERE id = :id").get({ id: id }) != null;
    const receiptCount = (id: number) => (database.prepare("SELECT COUNT(*) AS n FROM message_receipt WHERE message_id = :id").get({ id: id }) as { n: number }).n;
    function send(from: string, to: string, text = "hello", replyTo: number | null = null) {
        return store.sendMessage(from, { to: to, kind: replyTo == null ? "note" : "reply", text: text, replyTo: replyTo, requestId: null }).message_id;
    }

    it("keeps a message for a day, read or not, then deletes it with its receipts", () => {
        const sender = joinAgent("sender");
        const reader = joinAgent("reader");
        const id = send(sender.agent_id, reader.agent_id);
        store.acknowledge(reader.agent_id, [id]);
        ageMessage(id, 23 * 60);
        expect(store.purgeMessages()).toBe(0);
        ageMessage(id, 25 * 60);
        expect(store.purgeMessages()).toBe(1);
        expect(messageExists(id)).toBe(false);
        expect(receiptCount(id)).toBe(0);
    });

    it("deletes a message's topics with it", () => {
        const sender = joinAgent("sender");
        const reader = joinAgent("reader");
        const id = store.sendMessage(sender.agent_id, { to: reader.agent_id, kind: "note", text: "hello", replyTo: null, requestId: null, topics: ["concos_board"] }).message_id;
        store.acknowledge(reader.agent_id, [id]);
        ageMessage(id, 25 * 60);
        expect(store.purgeMessages()).toBe(1);
        expect(database.prepare("SELECT COUNT(*) AS n FROM message_topic").get()).toMatchObject({ n: 0 });
    });

    it("deletes a message past its lifetime even when an active agent never received it", () => {
        const sender = joinAgent("sender");
        const reader = joinAgent("reader");
        const id = send(sender.agent_id, reader.agent_id);
        ageMessage(id, 25 * 60);
        expect(store.purgeMessages()).toBe(1);
        expect(messageExists(id)).toBe(false);
    });

    it("keeps a message owed only by an ended session or a person for a day, then deletes it", () => {
        const sender = joinAgent("sender");
        const away = joinAgent("away");
        const person = store.ensureHumanParticipant("main", "Reviewer");
        const toAway = send(sender.agent_id, away.agent_id);
        const toPerson = send(sender.agent_id, person);
        store.disconnect([away.agent_id]);
        ageMessage(toAway, 23 * 60);
        ageMessage(toPerson, 23 * 60);
        expect(store.purgeMessages()).toBe(0);
        ageMessage(toAway, 25 * 60);
        ageMessage(toPerson, 25 * 60);
        expect(store.purgeMessages()).toBe(2);
    });

    it("keeps a message past its lifetime while a reply to it remains, and removes the thread together", () => {
        const asker = joinAgent("asker");
        const answerer = joinAgent("answerer");
        const question = send(asker.agent_id, answerer.agent_id, "which port?");
        store.acknowledge(answerer.agent_id, [question]);
        const answer = send(answerer.agent_id, asker.agent_id, "18201", question);
        ageMessage(question, 25 * 60);
        expect(store.purgeMessages()).toBe(0);
        expect(messageExists(question)).toBe(true);

        store.acknowledge(asker.agent_id, [answer]);
        ageMessage(answer, 25 * 60);
        expect(store.purgeMessages()).toBe(2);
    });

    it("stores a late answer without its link when the original was already deleted", () => {
        const asker = joinAgent("asker");
        const answerer = joinAgent("answerer");
        const question = send(asker.agent_id, answerer.agent_id, "which port?");
        store.acknowledge(answerer.agent_id, [question]);
        ageMessage(question, 25 * 60);
        expect(store.purgeMessages()).toBe(1);
        const late = store.sendMessage(answerer.agent_id, { to: asker.agent_id, kind: "reply", text: "18201", replyTo: question, requestId: null });
        expect(late.reply_target_removed).toBe(true);
        const stored = database.prepare("SELECT reply_to_message_id FROM message WHERE id = :id").get({ id: late.message_id }) as { reply_to_message_id: number | null };
        expect(stored.reply_to_message_id).toBeNull();
    });

    it("deletes agent cards silent for a week with their checkpoints, and workspaces no one uses", () => {
        const old = joinAgent("old");
        emptyCheckIn(old.agent_id, { checkpoint: "done long ago" });
        const named = joinAgent("named");
        const keeper = joinAgent("keeper");
        send(keeper.agent_id, named.agent_id);
        const person = store.ensureHumanParticipant("main", "Reviewer");
        const otherDirectory = path.join(dataDirectory, "elsewhere");
        fs.mkdirSync(otherDirectory);
        const lonely = joinAgent("lonely", "dev", otherDirectory);
        for(const agent of [old, named, lonely]) {
            database.prepare("UPDATE agent SET last_seen_at = :at WHERE id = :id").run({ at: minutesAgo(8 * 24 * 60), id: agent.agent_id });
        }
        database.prepare("UPDATE agent SET last_seen_at = :at WHERE id = :id").run({ at: minutesAgo(8 * 24 * 60), id: person });

        const removed = store.cleanUp();
        expect(removed).toMatchObject({ agents: 2, checkpoints: 1, workspaces: 1 });
        const remaining = (database.prepare("SELECT display_name FROM agent ORDER BY display_name").all() as { display_name: string }[]).map((row) => row.display_name);
        // a card a live message still names stays; people at the CLI are never retired
        expect(remaining).toEqual(["Reviewer", "keeper", "named"]);
        expect(database.prepare("SELECT id FROM workspace WHERE id = :id").get({ id: lonely.workspace_id })).toBeUndefined();
    });

    it("keeps only the newest checkpoints of a long session", () => {
        const busy = joinAgent("busy");
        for(let index = 0; index < 55; index += 1) {
            emptyCheckIn(busy.agent_id, { checkpoint: `step ${index}` });
        }
        expect(store.cleanUp().checkpoints).toBe(5);
        const kept = database.prepare("SELECT body FROM checkpoint WHERE agent_id = :id ORDER BY id").all({ id: busy.agent_id }) as { body: string }[];
        expect(kept).toHaveLength(50);
        expect(kept[0].body).toBe("step 5");
    });
});

describe("backup residue", () => {
    it("removes a temporary backup copy left by a crash, but not a fresh one another process may be writing", async () => {
        database.close();
        const stale = path.join(dataDirectory, "concos.db.bak-daily-2026-01-01.tmp-1234");
        const fresh = path.join(dataDirectory, "concos.db.bak-daily-2026-01-02.tmp-5678");
        fs.writeFileSync(stale, "partial");
        fs.writeFileSync(fresh, "partial");
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
        fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
        // the daily backup runs (and prunes) when today's copy is missing
        for(const name of fs.readdirSync(dataDirectory).filter((name) => /bak-daily-\d{4}-\d{2}-\d{2}$/.test(name))) {
            fs.rmSync(path.join(dataDirectory, name));
        }
        database = await openDatabase(dataDirectory);
        store = new RoomStore(database);
        expect(fs.existsSync(stale)).toBe(false);
        expect(fs.existsSync(fresh)).toBe(true);
    });
});

describe("opening the database", () => {
    it("refuses a schema newer than this build", async () => {
        database.exec("PRAGMA user_version = 99");
        await expect(openDatabase(dataDirectory)).rejects.toThrow(/update concos/);
    });
});
