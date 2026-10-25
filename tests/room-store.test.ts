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

    it("keeps one card per session: naming the hook's card after an earlier card of its own merges them into the earlier one", () => {
        const sender = joinAgent("sender");
        // the model joined by itself before the hooks knew the session, and got a message there
        const earlier = joinAgent("Dev / API 05");
        const missed = store.sendMessage(sender.agent_id, { to: earlier.agent_id, kind: "notice", text: "deploy decision", replyTo: null, requestId: null });
        emptyCheckIn(earlier.agent_id, { checkpoint: "before compaction" });
        // the session-start hook makes its own card; one more message reaches that card
        const hook = store.join({ room: "dev", displayName: "Claude Code · work", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: null, hookSession: { host: "claude", sessionId: "s1" } });
        const toHook = store.sendMessage(sender.agent_id, { to: hook.agent_id, kind: "note", text: "hello hook card", replyTo: null, requestId: null });

        const named = store.join({ room: "dev", displayName: "Dev / API 05", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: hook.handle });
        // the hook told the model its card's id; the answer says that card went into this one
        expect(named).toMatchObject({ agent_id: earlier.agent_id, handle: hook.handle, resumed: true, merged_from: hook.agent_id });
        expect(store.requireAgentIdByHandle(hook.handle)).toBe(earlier.agent_id);
        expect(database.prepare("SELECT id FROM agent WHERE id = :id").get({ id: hook.agent_id })).toBeUndefined();
        expect(store.readMessages(earlier.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([missed.message_id, toHook.message_id]);
        expect(store.inspectAgent(earlier.agent_id, { agentId: earlier.agent_id, checkpointLimit: null, beforeCheckpointId: null }).checkpoints[0].text).toBe("before compaction");
        // hook events now find the earlier card by the session key
        expect(store.applyHookEvent({ kind: "prompt", host: "claude", sessionId: "s1", cwd: workDirectory, files: [] })?.agentId).toBe(earlier.agent_id);
    });

    it("keeps a card with the project its session started in, and records the folder it works in now", () => {
        const docs = path.join(workDirectory, "docs-repo");
        fs.mkdirSync(docs);
        const joined = joinAgent("Designer");
        const inspect = () => store.inspectAgent(joined.agent_id, { agentId: joined.agent_id, checkpointLimit: null, beforeCheckpointId: null }).card;
        // joining again from a repository inside the project used to move the card to that repository
        const again = store.join({ room: "dev", displayName: "Designer", client: "test", workingDirectory: docs, workspaceRoot: null, resumeHandle: joined.handle });
        expect(again).toMatchObject({ agent_id: joined.agent_id, workspace_id: joined.workspace_id });
        expect(inspect()).toMatchObject({ working_directory: workDirectory, current_directory: docs, workspace: { id: joined.workspace_id } });
        expect(store.getRoomOverview("main", 0).agents[0]).toMatchObject({ workspace_path: workDirectory, current_directory: docs });

        // check_in reports it too; "" or the folder the session started in clears it
        emptyCheckIn(joined.agent_id, { update: { currentDirectory: "" } });
        expect(inspect().current_directory).toBeUndefined();
        const watcher = joinAgent("Watcher");
        emptyCheckIn(watcher.agent_id);
        emptyCheckIn(joined.agent_id, { update: { currentDirectory: docs } });
        expect(emptyCheckIn(watcher.agent_id).agents).toEqual([expect.objectContaining({ agent_id: joined.agent_id, current_directory: docs })]);
        emptyCheckIn(joined.agent_id, { update: { currentDirectory: workDirectory } });
        expect(inspect().current_directory).toBeUndefined();
        expect(() => emptyCheckIn(joined.agent_id, { update: { currentDirectory: "docs-repo" } })).toThrow(/absolute/);
    });

    it("merges by the project the session started in, even when the model joins from another folder", () => {
        const docs = path.join(workDirectory, "docs-repo");
        fs.mkdirSync(docs);
        const earlier = joinAgent("Dev / API 05");
        const hook = store.join({ room: "dev", displayName: "Claude Code · work", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: null, hookSession: { host: "claude", sessionId: "s1" } });
        const named = store.join({ room: "dev", displayName: "Dev / API 05", client: "Claude Code", workingDirectory: docs, workspaceRoot: null, resumeHandle: hook.handle });
        expect(named).toMatchObject({ agent_id: earlier.agent_id, merged_from: hook.agent_id, workspace_id: earlier.workspace_id });
        expect(store.inspectAgent(earlier.agent_id, { agentId: earlier.agent_id, checkpointLimit: null, beforeCheckpointId: null }).card)
            .toMatchObject({ working_directory: workDirectory, current_directory: docs });
    });

    it("leaves cards apart when the earlier one is elsewhere, bound to another session, or named otherwise", () => {
        const otherFolder = path.join(dataDirectory, "other");
        fs.mkdirSync(otherFolder);
        const elsewhere = joinAgent("Dev / API 05", "dev", otherFolder);
        const otherSession = store.join({ room: "dev", displayName: "Dev / API 05", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: null, hookSession: { host: "claude", sessionId: "s0" } });
        store.join({ room: "dev", displayName: "Dev / API 05", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: otherSession.handle });
        const hook = store.join({ room: "dev", displayName: "Claude Code · work", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: null, hookSession: { host: "claude", sessionId: "s1" } });
        const named = store.join({ room: "dev", displayName: "Dev / API 05", client: "Claude Code", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: hook.handle });
        expect(named.agent_id).toBe(hook.agent_id);
        expect(named.merged_from).toBeUndefined();
        const names = (database.prepare("SELECT id FROM agent WHERE display_name = :name").all({ name: "Dev / API 05" }) as { id: string }[]).map((row) => row.id);
        expect(names.sort()).toEqual([elsewhere.agent_id, otherSession.agent_id, hook.agent_id].sort());
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

    it("keeps an agent's role apart from its task, and lets the person at the board set it without making the agent look active", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        emptyCheckIn(ui.agent_id);
        emptyCheckIn(server.agent_id, { update: { role: "owner of the app-api service", task: "storage" } });
        emptyCheckIn(server.agent_id, { update: { task: "review" } });
        const seen = emptyCheckIn(ui.agent_id);
        expect(seen.agents).toEqual([expect.objectContaining({ agent_id: server.agent_id, role: "owner of the app-api service", task: "review" })]);

        const before = database.prepare("SELECT last_call_at, revision FROM agent WHERE id = :id").get({ id: server.agent_id }) as { last_call_at: string; revision: number };
        store.setRoleFromBoard(server.agent_id, "  test server deployments  ");
        const after = database.prepare("SELECT role, last_call_at, revision FROM agent WHERE id = :id").get({ id: server.agent_id }) as { role: string; last_call_at: string; revision: number };
        expect(after).toEqual({ role: "test server deployments", last_call_at: before.last_call_at, revision: before.revision + 1 });
        expect(emptyCheckIn(ui.agent_id).agents).toEqual([expect.objectContaining({ role: "test server deployments" })]);
        expect(store.inspectAgent(ui.agent_id, { agentId: server.agent_id, checkpointLimit: null, beforeCheckpointId: null }).card.role).toBe("test server deployments");
        expect(() => store.setRoleFromBoard(store.ensureHumanParticipant("main", "Reviewer"), "x")).toThrow(/no role card/);
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

    it("names the cut messages a check_in delivered, to read in full", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const long = store.sendMessage(ui.agent_id, { to: server.agent_id, kind: "notice", text: "x".repeat(MESSAGE_PREVIEW_LENGTH + 1), replyTo: null, requestId: null });
        store.sendMessage(ui.agent_id, { to: server.agent_id, kind: "note", text: "short", replyTo: null, requestId: null });
        expect(emptyCheckIn(server.agent_id).read_in_full).toEqual([long.message_id]);
        expect(emptyCheckIn(server.agent_id).read_in_full).toBeUndefined();
    });

    it("says why a message asked for by id is not shown", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const other = joinAgent("other");
        const toOther = store.sendMessage(ui.agent_id, { to: other.agent_id, kind: "note", text: "not for server", replyTo: null, requestId: null });
        const toServer = store.sendMessage(ui.agent_id, { to: server.agent_id, kind: "note", text: "for server", replyTo: null, requestId: null });
        const read = store.readMessages(server.agent_id, { messageIds: [toServer.message_id, toOther.message_id, 999], limit: null });
        expect(read.messages.map((message) => message.id)).toEqual([toServer.message_id]);
        expect(read.unavailable).toEqual([
            { id: toOther.message_id, reason: `sent to other (${other.agent_id}), not to you` },
            { id: 999, reason: expect.stringMatching(/^not found: deleted/) },
        ]);
        expect(store.readMessages(server.agent_id, { messageIds: [toServer.message_id], limit: null }).unavailable).toBeUndefined();
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

    const post = (from: string, text: string, topics: string[] = []) => store.sendMessage(from, { to: "all", kind: "notice", text: text, replyTo: null, requestId: null, topics: topics });
    const keptIds = () => (database.prepare("SELECT id FROM message ORDER BY id").all() as { id: number }[]).map((row) => row.id);

    it("posts a room-wide message for reference: nobody receives it, and every other agent sees it once on check_in", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        emptyCheckIn(ui.agent_id);
        emptyCheckIn(server.agent_id);
        const sent = post(ui.agent_id, "schema frozen");
        expect(sent).toMatchObject({ posted: true, recipient_count: 0 });
        expect(database.prepare("SELECT COUNT(*) AS n FROM message_receipt").get()).toMatchObject({ n: 0 });

        const seen = emptyCheckIn(server.agent_id);
        expect(seen.pending_count).toBe(0);
        expect(seen.messages).toEqual([expect.objectContaining({ id: sent.message_id, to: "all", text: "schema frozen" })]);
        expect(store.getInbox(server.agent_id)).toBeUndefined();
        expect(emptyCheckIn(server.agent_id).messages).toBeUndefined();
        expect(emptyCheckIn(ui.agent_id).messages).toBeUndefined();
        // a session that joins later sees the posts still kept
        expect(emptyCheckIn(joinAgent("late").agent_id).messages?.map((message) => message.id)).toEqual([sent.message_id]);
    });

    it("lets every agent read a post in full, find it by topic and answer it", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const sent = post(ui.agent_id, "x".repeat(MESSAGE_PREVIEW_LENGTH * 2), ["concos_release"]);
        expect(store.readMessages(server.agent_id, { messageIds: [sent.message_id], limit: null }).messages[0].text).toHaveLength(MESSAGE_PREVIEW_LENGTH * 2);
        expect(store.readMessages(server.agent_id, { messageIds: null, limit: null, topic: "concos" }).messages.map((message) => message.id)).toEqual([sent.message_id]);
        const answer = store.sendMessage(server.agent_id, { to: ui.agent_id, kind: "reply", text: "noted", replyTo: sent.message_id, requestId: null });
        expect(answer.reply_target_removed).toBeUndefined();
    });

    it("lets only the sender rewrite its post, which others see again marked edited", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const sent = post(ui.agent_id, "test DB restarts at 15:00", ["webapp_db"]);
        emptyCheckIn(server.agent_id);
        const edited = store.editPost(ui.agent_id, { messageId: sent.message_id, text: "test DB is back", topics: ["webapp_db_restart"] });
        expect(edited.message_id).toBe(sent.message_id);
        expect(emptyCheckIn(server.agent_id).messages).toEqual([expect.objectContaining({
            id: sent.message_id, kind: "notice", text: "test DB is back", topics: ["webapp_db_restart"], edited_at: edited.edited_at,
        })]);

        const direct = store.sendMessage(ui.agent_id, { to: server.agent_id, kind: "note", text: "hi", replyTo: null, requestId: null });
        expect(() => store.editPost(server.agent_id, { messageId: sent.message_id, text: "mine now" })).toThrow(/only those can be edited/);
        expect(() => store.editPost(ui.agent_id, { messageId: direct.message_id, text: "changed" })).toThrow(/only those can be edited/);
    });

    it("lets the sender take its posts down, all or none, leaving answers without the link", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const first = post(ui.agent_id, "server restarts at 15:00", ["webapp_db"]).message_id;
        const second = post(ui.agent_id, "migration after the restart").message_id;
        const theirs = post(server.agent_id, "server news").message_id;
        const answer = store.sendMessage(server.agent_id, { to: ui.agent_id, kind: "reply", text: "noted", replyTo: first, requestId: null }).message_id;

        expect(() => store.removePosts(ui.agent_id, [first, theirs])).toThrow(/not your posts to all: 3; nothing was removed/);
        expect(keptIds()).toEqual([first, second, theirs, answer]);
        expect(store.removePosts(ui.agent_id, [second, first])).toEqual({ removed: [first, second] });
        expect(keptIds()).toEqual([theirs, answer]);
        expect(store.readMessages(ui.agent_id, { messageIds: [answer], limit: null }).messages[0].reply_to).toBeUndefined();
        expect(database.prepare("SELECT COUNT(*) AS n FROM message_topic").get()).toMatchObject({ n: 0 });
    });

    it("never hands out a deleted message number again, even past one an older bridge inserted", () => {
        const ui = joinAgent("ui");
        const first = post(ui.agent_id, "first").message_id;
        const second = post(ui.agent_id, "second").message_id;
        store.removePosts(ui.agent_id, [second]);
        expect(post(ui.agent_id, "third").message_id).toBe(second + 1);
        // a bridge older than schema 9 lets SQLite pick the number
        database.prepare(`
            INSERT INTO message (seq, room, sender_agent_id, recipient_scope, kind, body, created_at)
            VALUES (100000, 'main', :sender, 'all', 'notice', 'old bridge', :at)
        `).run({ sender: ui.agent_id, at: new Date().toISOString() });
        const oldBridge = Math.max(...keptIds());
        expect(post(ui.agent_id, "fourth").message_id).toBe(oldBridge + 1);
        expect(first).toBeLessThan(second);
    });

    it("keeps each agent's newest three posts, an edit counting as new", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const ids = Array.from({ length: 5 }, (_, index) => post(ui.agent_id, `post ${index}`).message_id);
        const other = post(server.agent_id, "server news").message_id;
        store.editPost(ui.agent_id, { messageId: ids[0], text: "post 0, updated" });
        expect(store.purgeMessages()).toBe(2);
        expect(keptIds()).toEqual([ids[0], ids[3], ids[4], other]);
    });

    it("repairs what older bridges write: a room-wide message stored as direct, and receipts for a post", () => {
        const ui = joinAgent("ui");
        const server = joinAgent("server");
        const sent = post(ui.agent_id, "from an old bridge").message_id;
        database.prepare("UPDATE message SET recipient_scope = 'direct' WHERE id = :id").run({ id: sent });
        database.prepare("INSERT INTO message_receipt (message_id, agent_id) VALUES (:id, :agent_id)").run({ id: sent, agent_id: server.agent_id });
        store.cleanUp();
        expect(database.prepare("SELECT recipient_scope FROM message WHERE id = :id").get({ id: sent })).toMatchObject({ recipient_scope: "all" });
        expect(store.getInbox(server.agent_id)).toBeUndefined();
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

    it("shows a post to a session that was closed when it went up, once it comes back", () => {
        const sender = joinAgent("sender");
        const away = joinAgent("away");
        emptyCheckIn(away.agent_id);
        store.disconnect([away.agent_id]);
        silence(away.agent_id, 31);
        const sent = store.sendMessage(sender.agent_id, { to: "all", kind: "notice", text: "schema frozen", replyTo: null, requestId: null });
        store.join({ room: "dev", displayName: "away", client: "test", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: away.handle });
        expect(emptyCheckIn(away.agent_id).messages?.map((message) => message.id)).toEqual([sent.message_id]);
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
        store.markDelivered(receiver.agent_id, [sent.message_id]);
        store.disconnect([receiver.agent_id]);
        expect(store.getRoomOverview("main", 0).agents.find((agent) => agent.agent_id == receiver.agent_id)?.ended).toBe(true);

        store.recordCall(receiver.agent_id);
        const overview = store.getRoomOverview("main", 0).agents.find((agent) => agent.agent_id == receiver.agent_id)!;
        expect(overview).toMatchObject({ ended: false, online: true, pending_count: 0 });
    });

    it("keeps a full-text delivery in the database, so a call through another bridge acknowledges only that", async () => {
        const sender = joinAgent("sender");
        const receiver = joinAgent("receiver");
        const other = joinAgent("other");
        const send = (to: string, kind: "question" | "note") => store.sendMessage(sender.agent_id, { to: to, kind: kind, text: "x", replyTo: null, requestId: null }).message_id;
        const delivered = send(receiver.agent_id, "question");
        const previewed = send(receiver.agent_id, "note");
        const othersMessage = send(other.agent_id, "note");
        // an id that is not the receiver's changes nothing
        store.markDelivered(receiver.agent_id, [delivered, othersMessage]);
        expect(store.getInbox(receiver.agent_id)).toEqual({ questions: 1, notes: 1 });

        // the client restarted its MCP server: a new process opens the same database
        const connection = await openDatabase(dataDirectory);
        try {
            new RoomStore(connection).recordCall(receiver.agent_id);
        }
        finally { connection.close(); }
        expect(store.getInbox(receiver.agent_id)).toEqual({ questions: 0, notes: 1 });
        expect(store.readMessages(receiver.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([previewed]);
        expect(store.getInbox(other.agent_id)).toEqual({ questions: 0, notes: 1 });
    });

    it("counts a message delivered in this response out of the inbox it returns", () => {
        const sender = joinAgent("sender");
        const receiver = joinAgent("receiver");
        const question = store.sendMessage(sender.agent_id, { to: receiver.agent_id, kind: "question", text: "q", replyTo: null, requestId: null });
        store.sendMessage(sender.agent_id, { to: receiver.agent_id, kind: "note", text: "n", replyTo: null, requestId: null });
        expect(store.getInbox(receiver.agent_id)).toEqual({ questions: 1, notes: 1 });
        expect(store.getInbox(receiver.agent_id, [question.message_id])).toEqual({ questions: 0, notes: 1 });
    });

    it("hands a message for an ended card to the live card of the same name in the same project", () => {
        const sender = joinAgent("sender");
        const earlier = joinAgent("Dev / CONCOS 01");
        store.disconnect([earlier.agent_id]);
        const current = joinAgent("Dev / CONCOS 01");
        const sent = store.sendMessage(sender.agent_id, { to: earlier.agent_id, kind: "note", text: "report", replyTo: null, requestId: null });
        expect(sent).toMatchObject({ recipient_count: 1, forwarded: [{ from: earlier.agent_id, to: current.agent_id }] });
        expect(sent.inactive_recipients).toBeUndefined();
        expect(store.readMessages(current.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([sent.message_id]);
        // naming both cards reaches the live one once
        expect(store.sendMessage(sender.agent_id, { to: [earlier.agent_id, current.agent_id], kind: "note", text: "both", replyTo: null, requestId: null }).recipient_count).toBe(1);
        // the ended card shows where its messages go, in the room list and on inspection
        const inspect = (agentId: string) => store.inspectAgent(sender.agent_id, { agentId: agentId, checkpointLimit: null, beforeCheckpointId: null }).card;
        expect(emptyCheckIn(sender.agent_id).agents?.find((card) => card.agent_id == earlier.agent_id)?.replaced_by).toBe(current.agent_id);
        expect(inspect(earlier.agent_id).replaced_by).toBe(current.agent_id);
        expect(inspect(current.agent_id).replaced_by).toBeUndefined();

        // no single live card of that name in that project: stored for the ended card, as before
        const otherFolder = path.join(dataDirectory, "elsewhere");
        fs.mkdirSync(otherFolder);
        const lonely = joinAgent("Lonely");
        store.disconnect([lonely.agent_id]);
        joinAgent("Lonely", "dev", otherFolder);
        expect(store.sendMessage(sender.agent_id, { to: lonely.agent_id, kind: "note", text: "x", replyTo: null, requestId: null })).toMatchObject({ inactive_recipients: [lonely.agent_id] });
        expect(inspect(lonely.agent_id).replaced_by).toBeUndefined();
    });

    it("gives a session joining under a name the unread messages left on ended cards of that name", () => {
        const sender = joinAgent("sender");
        const earlier = joinAgent("Dev / CONCOS 01");
        const waiting = store.sendMessage(sender.agent_id, { to: earlier.agent_id, kind: "notice", text: "left behind", replyTo: null, requestId: null });
        const read = store.sendMessage(sender.agent_id, { to: earlier.agent_id, kind: "note", text: "already read", replyTo: null, requestId: null });
        store.acknowledge(earlier.agent_id, [read.message_id]);
        // its whole text went out to the earlier session, which ended before calling again
        store.markDelivered(earlier.agent_id, [waiting.message_id]);
        store.disconnect([earlier.agent_id]);
        const current = joinAgent("Dev / CONCOS 01");
        store.recordCall(current.agent_id);
        expect(store.readMessages(current.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([waiting.message_id]);
        expect(store.getRoomOverview("main", 10).messages.find((message) => message.id == waiting.message_id)?.to_agent_id).toBe(current.agent_id);
        // what the earlier session read stays its own
        expect(store.readMessages(current.agent_id, { messageIds: [read.message_id], limit: null }).messages).toEqual([]);
    });

    it("resolves a reused session name to the live session", () => {
        const old = joinAgent("Dev / API 01");
        store.disconnect([old.agent_id]);
        const current = joinAgent("Dev / API 01");
        expect(store.findAgentInRoom("main", "dev / api 01")).toBe(current.agent_id);
    });
});

describe("cards that look wrong", () => {
    const overviewOf = (agentId: string) => store.getRoomOverview("main", 0).agents.find((agent) => agent.agent_id == agentId)!;
    const setRow = (agentId: string, values: Record<string, string>) => {
        const assignments = Object.keys(values).map((key) => `${key} = :${key}`).join(", ");
        database.prepare(`UPDATE agent SET ${assignments} WHERE id = :id`).run({ ...values, id: agentId });
    };

    it("records the concos version of the bridge that joined or keeps the card alive, and flags an older one", () => {
        const joined = store.join({ room: "dev", displayName: "Old", client: "test", workingDirectory: workDirectory, workspaceRoot: null, resumeHandle: null, concosVersion: "0.1.11" });
        expect(overviewOf(joined.agent_id)).toMatchObject({ concos_version: "0.1.11", issues: [] });
        // a bridge left over from an earlier concos keeps beating the card
        store.heartbeat([joined.agent_id], "0.0.1");
        expect(overviewOf(joined.agent_id)).toMatchObject({ concos_version: "0.0.1", issues: [{ kind: "old_concos", version: "0.0.1" }] });
        // a hook's join leaves the version as it is
        store.heartbeat([joined.agent_id]);
        expect(overviewOf(joined.agent_id).concos_version).toBe("0.0.1");
    });

    it("flags a card that says working but has not acted for an hour, and the older of two cards with one name", () => {
        const quiet = joinAgent("Quiet");
        emptyCheckIn(quiet.agent_id, { update: { status: "working" } });
        setRow(quiet.agent_id, { last_call_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() });
        expect(overviewOf(quiet.agent_id).issues).toEqual([{ kind: "stuck", since: expect.any(String) }]);

        const older = joinAgent("Twin");
        const newer = joinAgent("Twin");
        setRow(older.agent_id, { last_call_at: new Date(Date.now() - 60_000).toISOString() });
        expect(overviewOf(older.agent_id).issues).toEqual([{ kind: "duplicate", newer_agent_id: newer.agent_id }]);
        expect(overviewOf(newer.agent_id).issues).toEqual([]);
        // an ended card is folded away, not flagged
        store.disconnect([older.agent_id]);
        expect(overviewOf(older.agent_id).issues).toEqual([]);
    });

    it("takes a card down from the board, handing its unread messages to the live card of its name", () => {
        const sender = joinAgent("sender");
        const stale = joinAgent("Twin");
        const live = joinAgent("Twin");
        const waiting = store.sendMessage(sender.agent_id, { to: stale.agent_id, kind: "question", text: "still there?", replyTo: null, requestId: null });
        emptyCheckIn(stale.agent_id, { update: { editing: ["src/a.ts"], currentDirectory: path.join(workDirectory, "sub") } });
        expect(store.retireAgent(stale.agent_id)).toEqual({ moved_to: live.agent_id });
        expect(overviewOf(stale.agent_id)).toMatchObject({ left: true, status: "finished", editing: [], current_directory: null });
        expect(store.readMessages(live.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([waiting.message_id]);
        // its bridge beating on does not bring it back; taking it down again changes nothing
        store.heartbeat([stale.agent_id], "0.1.11");
        expect(overviewOf(stale.agent_id).left).toBe(true);
        expect(store.retireAgent(stale.agent_id)).toEqual({ moved_to: null });
        // without a live card of its name the messages stay on record with it
        const alone = joinAgent("Alone");
        expect(store.retireAgent(alone.agent_id)).toEqual({ moved_to: null });
        expect(() => store.retireAgent(store.ensureHumanParticipant("main", "Reviewer"))).toThrow(/person/);
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
        const sent = store.sendMessage(sender.agent_id, { to: [first.agent_id, second.agent_id], kind: "notice", text: "deploy at 5", replyTo: null, requestId: null });
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
        store.recordCall(idle.agent_id);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: false, waiting_on: ["idle"] });
    });

    it("does not wait on a recipient whose session ended, and reopens when it comes back", () => {
        const sender = joinAgent("sender");
        const away = joinAgent("away");
        const sent = store.sendMessage(sender.agent_id, { to: away.agent_id, kind: "note", text: "later", replyTo: null, requestId: null });
        store.disconnect([away.agent_id]);
        expect(messageState(sent.message_id)).toMatchObject({ resolved: true });
        store.recordCall(away.agent_id);
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

    it("never waits on anyone for a post", () => {
        const sender = joinAgent("sender");
        joinAgent("other");
        const sent = store.sendMessage(sender.agent_id, { to: "all", kind: "question", text: "anyone on port 5173?", replyTo: null, requestId: null });
        expect(sent.recipient_count).toBe(0);
        expect(messageState(sent.message_id)).toMatchObject({ posted: true, resolved: true, waiting_on: [] });
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

    it("deletes a message an hour after its last recipient read it, with its receipts", () => {
        const sender = joinAgent("sender");
        const first = joinAgent("first");
        const second = joinAgent("second");
        const id = store.sendMessage(sender.agent_id, { to: [first.agent_id, second.agent_id], kind: "note", text: "both", replyTo: null, requestId: null }).message_id;
        store.acknowledge(first.agent_id, [id]);
        ageMessage(id, 120);
        expect(store.purgeMessages()).toBe(0);
        store.acknowledge(second.agent_id, [id]);
        ageMessage(id, 59);
        expect(store.purgeMessages()).toBe(0);
        ageMessage(id, 61);
        expect(store.purgeMessages()).toBe(1);
        expect(messageExists(id)).toBe(false);
        expect(receiptCount(id)).toBe(0);
    });

    it("keeps a read question until an answer to it was read an hour ago, then removes both", () => {
        const asker = joinAgent("asker");
        const answerer = joinAgent("answerer");
        const question = store.sendMessage(asker.agent_id, { to: answerer.agent_id, kind: "question", text: "which port?", replyTo: null, requestId: null }).message_id;
        store.acknowledge(answerer.agent_id, [question]);
        ageMessage(question, 120);
        expect(store.purgeMessages()).toBe(0);
        const answer = send(answerer.agent_id, asker.agent_id, "18201", question);
        store.acknowledge(asker.agent_id, [answer]);
        expect(store.purgeMessages()).toBe(0);
        ageMessage(answer, 61);
        expect(store.purgeMessages()).toBe(2);
    });

    it("keeps a post a day from its last edit", () => {
        const sender = joinAgent("sender");
        const id = store.sendMessage(sender.agent_id, { to: "all", kind: "notice", text: "v1", replyTo: null, requestId: null }).message_id;
        ageMessage(id, 25 * 60);
        store.editPost(sender.agent_id, { messageId: id, text: "v2" });
        expect(store.purgeMessages()).toBe(0);
        database.prepare("UPDATE message SET edited_at = :at WHERE id = :id").run({ at: minutesAgo(25 * 60), id: id });
        expect(store.purgeMessages()).toBe(1);
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

    it("keeps the newest daily backups by date, without counting SQLite side files as backups", async () => {
        database.close();
        const daily = (day: string) => path.join(dataDirectory, `concos.db.bak-daily-2026-01-${day}`);
        for(const name of fs.readdirSync(dataDirectory).filter((name) => name.includes(".bak-daily-"))) {
            fs.rmSync(path.join(dataDirectory, name));
        }
        for(const day of ["01", "02", "03", "04", "05", "06", "07", "08"]) fs.writeFileSync(daily(day), "copy");
        // side files of a kept backup someone opened, and of one that goes
        for(const side of ["-wal", "-shm"]) {
            fs.writeFileSync(`${daily("08")}${side}`, "");
            fs.writeFileSync(`${daily("01")}${side}`, "");
        }
        database = await openDatabase(dataDirectory);
        store = new RoomStore(database);
        const backups = fs.readdirSync(dataDirectory).filter((name) => /bak-daily-\d{4}-\d{2}-\d{2}$/.test(name)).sort();
        // today's copy and the six newest before it
        expect(backups).toHaveLength(7);
        expect(backups.slice(0, 6)).toEqual(["03", "04", "05", "06", "07", "08"].map((day) => path.basename(daily(day))));
        expect(fs.existsSync(`${daily("08")}-wal`)).toBe(true);
        expect(fs.existsSync(`${daily("01")}-wal`) || fs.existsSync(`${daily("01")}-shm`)).toBe(false);
    });

    it("keeps the newest migration backup by time, v10 after v9, until it is a week old", async () => {
        const stamp = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().replace(/[:.]/g, "-");
        const backup = (version: number, daysAgo: number) => path.join(dataDirectory, `concos.db.bak-v${version}-${stamp(daysAgo)}`);
        const migrationBackups = () => fs.readdirSync(dataDirectory).filter((name) => name.includes(".bak-v"));
        // the day's housekeeping runs when today's daily copy is missing
        const reopenForTheDay = async () => {
            database.close();
            for(const name of fs.readdirSync(dataDirectory).filter((name) => /bak-daily-\d{4}-\d{2}-\d{2}$/.test(name))) {
                fs.rmSync(path.join(dataDirectory, name));
            }
            database = await openDatabase(dataDirectory);
            store = new RoomStore(database);
        };
        const newest = backup(10, 1);
        for(const file of [newest, backup(9, 2), backup(8, 10)]) fs.writeFileSync(file, "copy");
        await reopenForTheDay();
        expect(migrationBackups()).toEqual([path.basename(newest)]);

        // past the daily backups' week it goes, even as the only one
        fs.rmSync(newest);
        fs.writeFileSync(backup(10, 8), "copy");
        await reopenForTheDay();
        expect(migrationBackups()).toEqual([]);

        // a name without a time is left to the count
        fs.writeFileSync(path.join(dataDirectory, "concos.db.bak-v10-no-time"), "copy");
        await reopenForTheDay();
        expect(migrationBackups()).toEqual(["concos.db.bak-v10-no-time"]);
    });
});

describe("opening the database", () => {
    it("refuses a schema newer than this build", async () => {
        database.exec("PRAGMA user_version = 99");
        await expect(openDatabase(dataDirectory)).rejects.toThrow(/update concos/);
    });
});
