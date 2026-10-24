import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/modules/store/database";
import { SCHEMA_STEPS } from "../src/modules/store/schema";
import { RoomStore } from "../src/modules/store/room-store";
import { processHook } from "../src/modules/hooks/handler";
import { getHostAdapter, HOST_ADAPTERS } from "../src/modules/hooks/adapters";
import { watchForWake } from "../src/modules/hooks/watch";
import type { HookEvent, HookEventKind } from "../src/modules/hooks/types";

let directory: string;
let database: DatabaseSync;
let store: RoomStore;

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-hooks-"));
    database = await openDatabase(directory);
    store = new RoomStore(database);
});
afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function event(kind: HookEventKind, extra: Partial<HookEvent> = {}): HookEvent {
    return { host: "claude", sessionId: "session-1", cwd: directory, files: [], kind, ...extra };
}
function start(extra: Partial<HookEvent> = {}) {
    return store.applyHookEvent(event("session-start", extra), "dev")!.joined!;
}
function card(agentId: string) {
    return store.inspectAgent(agentId, { agentId, checkpointLimit: null, beforeCheckpointId: null }).card;
}

describe("hook lifecycle", () => {
    it("restores a stable private handle across processes and keeps different hosts/sessions separate", async () => {
        const first = start();
        const second = start({ sessionId: "session-2" });
        const third = start({ host: "codex" });
        expect(new Set([first.agent_id, second.agent_id, third.agent_id]).size).toBe(3);
        store.leave(first.agent_id, { summary: "kept", nextStep: null, checkpoint: "checkpoint" });
        const connection = await openDatabase(directory);
        try {
            const restarted = new RoomStore(connection).applyHookEvent(event("session-start"), "dev")!.joined!;
            expect(restarted).toMatchObject({ agent_id: first.agent_id, handle: first.handle, resumed: true });
            expect(card(first.agent_id)).toMatchObject({ status: "working", left: false, summary: "kept" });
        }
        finally { connection.close(); }
        expect(store.applyHookEvent(event("session-start"), "other-room")!.joined!.agent_id).toBe(first.agent_id);
    });

    it("shares a participant with explicit MCP resume without merging same-folder agents", () => {
        const joined = start();
        const mcp = store.join({ room: "dev", displayName: "UI", client: "Claude Code", workingDirectory: directory, workspaceRoot: null, resumeHandle: joined.handle });
        expect(mcp.agent_id).toBe(joined.agent_id);
        start();
        expect(card(joined.agent_id).name).toBe("UI");
        const separate = store.join({ room: "dev", displayName: "another", client: "Claude Code", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        expect(separate.agent_id).not.toBe(joined.agent_id);
    });

    it("adds and deduplicates edits, clears on turn/session end, and preserves model context", () => {
        const joined = start();
        store.checkIn(joined.agent_id, { update: { summary: "model summary", task: "real work" }, receivedMessageIds: [], checkpoint: "record", cursor: null, expectedRevision: null });
        store.applyHookEvent(event("file-edited", { files: ["src/a.ts", path.join(directory, "src", "b.ts")] }), "dev");
        store.applyHookEvent(event("file-edited", { files: ["src/a.ts"] }), "dev");
        expect(card(joined.agent_id).editing).toEqual(["src/a.ts", "src/b.ts"]);
        store.applyHookEvent(event("turn-end"), "dev");
        expect(card(joined.agent_id)).toMatchObject({ status: "waiting", editing: [], summary: "model summary", task: "real work" });
        store.applyHookEvent(event("prompt"), "dev");
        expect(card(joined.agent_id).status).toBe("working");
        store.applyHookEvent(event("file-edited", { files: ["src/c.ts"] }), "dev");
        store.applyHookEvent(event("session-end"), "dev");
        store.heartbeat([joined.agent_id]);
        expect(card(joined.agent_id)).toMatchObject({ online: false, left: false, editing: [] });
        expect(store.inspectAgent(joined.agent_id, { agentId: joined.agent_id, checkpointLimit: null, beforeCheckpointId: null }).checkpoints).toHaveLength(1);
    });

    it("does not create participants on late events or revive an explicitly left participant", () => {
        expect(store.applyHookEvent(event("prompt"), "dev")).toBeNull();
        const joined = start();
        store.leave(joined.agent_id, { summary: null, nextStep: null, checkpoint: null });
        expect(store.applyHookEvent(event("file-edited", { files: ["x.ts"] }), "dev")).toBeNull();
        expect(card(joined.agent_id).left).toBe(true);
    });

    it("points at unread messages by number only, without acknowledging them or moving the MCP cursor", () => {
        const joined = start();
        const sender = store.ensureHumanParticipant("dev", "human");
        const question = store.sendMessage(sender, { to: joined.agent_id, text: "private question body", kind: "question", replyTo: null, requestId: null });
        const sent = (["note", "notice", "reply"] as const).map((kind) => store.sendMessage(sender, {
            to: joined.agent_id, text: "body", kind, replyTo: kind == "reply" ? question.message_id : null, requestId: null,
        }).message_id);
        const before = database.prepare("SELECT delivered_seq FROM agent WHERE id = ?").get(joined.agent_id);
        const output = processHook(store, event("prompt"), "dev");
        // notes and notices are named too; an answer to another's question is not
        expect(output?.context).toBe(`concos: unread for you — question #${question.message_id} from human; note #${sent[0]} from human; notice #${sent[1]} from human. Read them with read_messages.`);
        expect(database.prepare("SELECT delivered_seq FROM agent WHERE id = ?").get(joined.agent_id)).toEqual(before);
        expect(store.getInbox(joined.agent_id)).toEqual({ questions: 1, notes: 3 });
        store.checkIn(joined.agent_id, { update: {}, receivedMessageIds: [question.message_id, sent[0], sent[1]], cursor: null, expectedRevision: null, checkpoint: null });
        expect(processHook(store, event("prompt"), "dev")).toBeUndefined();
        expect(store.getInbox(joined.agent_id)).toEqual({ questions: 0, notes: 1 });
    });

    it("names a new hook participant after its client and folder, and tells the model how to keep it", () => {
        const result = processHook(store, event("session-start", { client: "Claude Code" }), "dev");
        expect(result?.context).toContain("resume_handle=");
        expect(result?.context).toContain("this session's name as display_name");
        const agentId = /agent_id=(agt_\w+);/.exec(result?.context ?? "")?.[1] ?? "";
        expect(card(agentId).name).toBe(`Claude Code · ${path.basename(directory)}`);
    });
});

describe("turn end", () => {
    function joinOther(displayName: string) {
        return store.join({ room: "main", displayName, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
    }
    function send(from: string, to: string | string[], kind: "question" | "reply" | "note" = "question", replyTo: number | null = null) {
        return store.sendMessage(from, { to, kind, text: "body", replyTo, requestId: null }).message_id;
    }
    const turnEnd = (canContinue: boolean) => store.applyHookEvent(event("turn-end", { canContinue }), "dev");

    it("continues once for a new question, staying at work with its editing claims", () => {
        const joined = start();
        const asker = joinOther("Asker");
        store.applyHookEvent(event("prompt"), "dev");
        store.applyHookEvent(event("file-edited", { files: ["src/a.ts"] }), "dev");
        const first = send(asker.agent_id, joined.agent_id);
        expect(turnEnd(true)?.continueFor?.map((notice) => notice.id)).toEqual([first]);
        expect(card(joined.agent_id)).toMatchObject({ status: "working", editing: ["src/a.ts"] });
        // the same message, still unacknowledged because the next MCP call has not come: no second continuation
        expect(turnEnd(true)?.continueFor).toBeUndefined();
        expect(card(joined.agent_id)).toMatchObject({ status: "waiting", editing: [] });
        const second = send(asker.agent_id, joined.agent_id);
        expect(turnEnd(true)?.continueFor?.map((notice) => notice.id)).toEqual([second]);
    });

    it("lets a turn the host is already continuing end, and points out its message at the next turn end", () => {
        const joined = start();
        const asker = joinOther("Asker");
        const question = send(asker.agent_id, joined.agent_id);
        expect(turnEnd(false)?.continueFor).toBeUndefined();
        expect(card(joined.agent_id).status).toBe("waiting");
        expect(turnEnd(true)?.continueFor?.map((notice) => notice.id)).toEqual([question]);
    });

    it("points at questions named to it and answers to its own questions only", () => {
        const joined = start();
        const asker = joinOther("Asker");
        const other = joinOther("Other");
        const direct = send(asker.agent_id, joined.agent_id);
        const group = send(asker.agent_id, [joined.agent_id, other.agent_id]);
        send(asker.agent_id, "all");
        const note = send(asker.agent_id, joined.agent_id, "note");
        const mine = send(joined.agent_id, asker.agent_id);
        const answer = send(asker.agent_id, joined.agent_id, "reply", mine);
        // an answer to the asker's own question, and an answer to an answer
        send(asker.agent_id, joined.agent_id, "reply", direct);
        const myAnswer = send(joined.agent_id, asker.agent_id, "reply", direct);
        send(asker.agent_id, joined.agent_id, "reply", myAnswer);
        expect(store.hookNotices(joined.agent_id).map((notice) => notice.id)).toEqual([direct, group, answer]);
        // a prompt's line names notes too; a turn end still continues only for the others
        expect(store.applyHookEvent(event("prompt"), "dev")?.notices?.map((notice) => notice.id)).toEqual([direct, group, note, answer]);
        expect(processHook(store, event("prompt"), "dev")?.context).toContain(`note #${note} from Asker`);
        expect(turnEnd(true)?.continueFor?.map((notice) => notice.id)).toEqual([direct, group, answer]);
    });

    it("names up to three messages with sender and first topic, counts the rest, and leaves the text out", () => {
        const joined = start();
        const asker = joinOther("Asker");
        const ids = [1, 2, 3, 4].map(() => store.sendMessage(asker.agent_id, {
            to: joined.agent_id, kind: "question", text: "secret body", replyTo: null, requestId: null, topics: ["concos_hooks"],
        }).message_id);
        const reason = processHook(store, event("turn-end", { canContinue: true }), "dev")?.continueReason ?? "";
        expect(reason).toContain(`question #${ids[0]} from Asker [concos_hooks]; question #${ids[1]}`);
        expect(reason).toContain("; 1 more.");
        expect(reason).toContain("then finish.");
        expect(reason).not.toContain("secret body");
    });

    it("never continues a turn on a host without a way to continue it", () => {
        const payload = { session_id: "s", sessionId: "s", conversation_id: "s", cwd: directory };
        expect(HOST_ADAPTERS.filter((adapter) => adapter.continueTurn != null).map((adapter) => adapter.id)).toEqual(["claude", "codex"]);
        for(const id of ["claude", "codex"]) {
            const adapter = getHostAdapter(id);
            expect(adapter.normalize("turn-end", { ...payload, stop_hook_active: false })?.canContinue).toBe(true);
            expect(adapter.normalize("turn-end", { ...payload, stop_hook_active: true })?.canContinue).toBe(false);
            expect(adapter.continueTurn?.("why")).toEqual({ decision: "block", reason: "why" });
        }
        const gemini = getHostAdapter("gemini").normalize("turn-end", payload);
        expect(gemini?.canContinue).toBeUndefined();
        const joined = start({ host: "gemini" });
        send(joinOther("Asker").agent_id, joined.agent_id);
        expect(store.applyHookEvent({ ...gemini!, host: "gemini", sessionId: "session-1" }, "dev")?.continueFor).toBeUndefined();
    });
});

describe("idle wake", () => {
    function asker() {
        return store.join({ room: "main", displayName: "Asker", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null }).agent_id;
    }
    function ask(from: string, to: string) {
        return store.sendMessage(from, { to, kind: "question", text: "body", replyTo: null, requestId: null }).message_id;
    }
    const watch = () => store.startWakeWatch(event("watch"))!;

    it("wakes once a question is waiting after the quiet time, then ends that watch", () => {
        const joined = start();
        const from = asker();
        const live = watch();
        expect(store.checkWakeWatch(live, true)).toEqual({ state: "wait" });
        const question = ask(from, joined.agent_id);
        expect(store.checkWakeWatch(live, false)).toEqual({ state: "wait" });
        expect(store.checkWakeWatch(live, true)).toMatchObject({ state: "wake", notices: [{ id: question }] });
        expect(store.checkWakeWatch(live, true)).toEqual({ state: "stop" });
        // pointed out once: neither the next turn end nor the next watch comes back to it
        expect(store.applyHookEvent(event("turn-end", { canContinue: true }), "dev")?.continueFor).toBeUndefined();
        expect(store.checkWakeWatch(watch(), true)).toEqual({ state: "wait" });
    });

    it("wakes for a question the last turn end could not point out", () => {
        const joined = start();
        const question = ask(asker(), joined.agent_id);
        // a turn the host was already continuing ends without continuing again
        store.applyHookEvent(event("turn-end", { canContinue: false }), "dev");
        expect(store.checkWakeWatch(watch(), true)).toMatchObject({ state: "wake", notices: [{ id: question }] });
    });

    it("ends a watch when a prompt arrives, a newer watch starts, or the session ends", () => {
        start();
        const first = watch();
        store.applyHookEvent(event("prompt"), "dev");
        expect(store.checkWakeWatch(first, true)).toEqual({ state: "stop" });
        const second = watch();
        const third = watch();
        expect(store.checkWakeWatch(second, true)).toEqual({ state: "stop" });
        expect(store.checkWakeWatch(third, true)).toEqual({ state: "wait" });
        store.applyHookEvent(event("session-end"), "dev");
        expect(store.checkWakeWatch(third, true)).toEqual({ state: "stop" });
        expect(store.startWakeWatch(event("watch", { sessionId: "never-started" }))).toBeNull();
    });

    it("wakes a session at most four times an hour", () => {
        const joined = start();
        const from = asker();
        const nowMs = Date.now();
        for(let index = 0; index < 4; index += 1) {
            ask(from, joined.agent_id);
            expect(store.checkWakeWatch(watch(), true, nowMs + index * 1000).state).toBe("wake");
        }
        ask(from, joined.agent_id);
        const capped = watch();
        expect(store.checkWakeWatch(capped, true, nowMs + 5000).state).toBe("wait");
        expect(store.checkWakeWatch(capped, true, nowMs + 60 * 60 * 1000 + 1000).state).toBe("wake");
    });

    it("resolves the watch with the wake line when a question arrives, or with nothing when its time runs out", async () => {
        const joined = start();
        const from = asker();
        const waking = watchForWake(store, event("watch"), { idleMs: 0, pollMs: 5, watchMs: 2000 });
        setTimeout(() => ask(from, joined.agent_id), 30);
        expect(await waking).toMatch(/^concos: unread for you — question #\d+ from Asker\. Read them with read_messages/);
        expect(await watchForWake(store, event("watch"), { idleMs: 0, pollMs: 5, watchMs: 40 })).toBeNull();
    });
});

describe("schema migration", () => {
    it("merges version 2 rooms without losing identities, messages, receipts, checkpoints or cursor pages", async () => {
        const oldDirectory = path.join(directory, "multiple-rooms");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        old.exec("PRAGMA journal_mode = WAL");
        old.exec(SCHEMA_STEPS[0]);
        old.exec(SCHEMA_STEPS[1]);
        old.exec("PRAGMA user_version = 2");
        // Version 2 rows are written as SQL: today's store reads and fills tables and columns that
        // version 2 does not have. Handles are hashed as the store hashes them, and the hook
        // session's handle comes from the version 2 secret, as session-start derives it.
        const nextSeq = () => (old.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'last_seq' RETURNING CAST(value AS INTEGER) AS seq").get() as { seq: number }).seq;
        const now = new Date().toISOString();
        const workspaceId = "ws_version2";
        old.prepare("INSERT INTO workspace (id, display_path, compare_path, is_verified, created_at) VALUES (?, ?, ?, 1, ?)")
            .run(workspaceId, directory, directory, now);
        const secret = (old.prepare("SELECT value FROM meta WHERE key = 'hook_handle_secret'").get() as { value: string }).value;
        const agents = Array.from({ length: 6 }, (_, index) => {
            const agentId = `agt_version2_${index}`;
            let handle = `version2-handle-${index}`;
            let host: string | null = null;
            let sessionId: string | null = null;
            if(index == 0) {
                host = "claude";
                sessionId = "preserved-session";
                handle = createHmac("sha256", secret).update(JSON.stringify([host, sessionId])).digest("base64url");
            }
            old.prepare(`
                INSERT INTO agent (id, room, handle_hash, display_name, client, workspace_id, working_directory,
                    changed_seq, joined_at, updated_at, last_seen_at, host, host_session_id)
                VALUES (?, 'main', ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(agentId, createHash("sha256").update(handle).digest("hex"), `Agent ${index}`, workspaceId, directory,
                nextSeq(), now, now, now, host, sessionId);
            return { agent_id: agentId, handle: handle, workspace_id: workspaceId };
        });
        // agent 1 has already been delivered every old card before the message is recorded
        old.prepare("UPDATE agent SET delivered_seq = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'last_seq') WHERE id = ?").run(agents[1].agent_id);
        const question = old.prepare(`
            INSERT INTO message (seq, room, sender_agent_id, recipient_agent_id, kind, body, request_id, created_at)
            VALUES (?, 'main', ?, ?, 'question', 'Keep this question', 'preserved-request', ?)
            RETURNING id AS message_id
        `).get(nextSeq(), agents[0].agent_id, agents[1].agent_id, now) as { message_id: number };
        old.prepare("INSERT INTO message_receipt (message_id, agent_id) VALUES (?, ?)").run(question.message_id, agents[1].agent_id);
        old.prepare(`
            UPDATE agent
            SET summary = 'Keep this context', editing_list = '["work.ts"]', revision = revision + 1,
                changed_seq = ?, updated_at = ?, editing_updated_at = ?
            WHERE id = ?
        `).run(nextSeq(), now, now, agents[0].agent_id);
        old.prepare("INSERT INTO checkpoint (agent_id, workspace_id, body, created_at) VALUES (?, ?, 'Keep this checkpoint', ?)")
            .run(agents[0].agent_id, agents[0].workspace_id, now);
        old.prepare("UPDATE agent SET room = CASE WHEN id = ? THEN 'project-b' ELSE 'project-a' END").run(agents[1].agent_id);
        old.exec("UPDATE message SET room = 'project-a'");
        const upgraded = await openDatabase(oldDirectory);
        try {
            const current = new RoomStore(upgraded);
            expect(upgraded.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: SCHEMA_STEPS.length });
            expect(current.listRooms()).toEqual(["main"]);
            expect(current.requireAgentIdByHandle(agents[0].handle)).toBe(agents[0].agent_id);
            expect(current.inspectAgent(agents[1].agent_id, { agentId: agents[0].agent_id, checkpointLimit: null, beforeCheckpointId: null }))
                .toMatchObject({ card: { summary: "Keep this context", editing: ["work.ts"], workspace: { id: agents[0].workspace_id } }, checkpoints: [{ text: "Keep this checkpoint" }] });
            expect(current.getInbox(agents[1].agent_id)).toEqual({ questions: 1, notes: 0 });
            const seen = new Set<string>();
            const messages: number[] = [];
            for(let page = 0; page < 10; page++) {
                const result = current.checkIn(agents[1].agent_id, { update: {}, checkpoint: null, receivedMessageIds: [], cursor: null, expectedRevision: null });
                for(const agent of result.agents ?? []) seen.add(agent.agent_id);
                messages.push(...(result.messages ?? []).map((message) => message.id));
                if(!result.has_more) break;
            }
            expect(seen).toEqual(new Set(agents.filter((agent) => agent.agent_id != agents[1].agent_id).map((agent) => agent.agent_id)));
            expect(messages).toEqual([question.message_id]);
            expect(current.applyHookEvent(event("session-start", { sessionId: "preserved-session" }))!.joined!.handle).toBe(agents[0].handle);
            expect(upgraded.prepare("SELECT COUNT(*) AS count FROM agent").get()).toMatchObject({ count: 6 });
            expect(upgraded.prepare("SELECT COUNT(*) AS count FROM message_receipt").get()).toMatchObject({ count: 1 });
            expect(() => upgraded.exec("UPDATE agent SET room = 'another'")).toThrow(/shared room/);
            const backupName = fs.readdirSync(oldDirectory).find((file) => file.includes(".bak-v2-"))!;
            const backup = new DatabaseSync(path.join(oldDirectory, backupName));
            try {
                expect(backup.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
                expect(backup.prepare("SELECT COUNT(DISTINCT room) AS count FROM agent").get()).toMatchObject({ count: 2 });
            }
            finally { backup.close(); }
        }
        finally { upgraded.close(); old.close(); }
    });

    it("turns version 7 room-wide messages into posts without receipts, including ones older bridges stored as direct", async () => {
        const oldDirectory = path.join(directory, "version7");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        for(const step of SCHEMA_STEPS.slice(0, 7)) old.exec(step);
        old.exec("PRAGMA user_version = 7");
        const now = new Date().toISOString();
        const insertAgent = old.prepare(`
            INSERT INTO agent (id, room, handle_hash, display_name, client, changed_seq, joined_at, updated_at, last_seen_at, last_call_at)
            VALUES (?, 'main', ?, ?, 'test', 1, ?, ?, ?, ?)
        `);
        for(const name of ["sender", "reader"]) insertAgent.run(name, `hash-${name}`, name, now, now, now, now);
        const insertMessage = old.prepare(`
            INSERT INTO message (seq, room, sender_agent_id, recipient_agent_id, recipient_scope, kind, body, created_at)
            VALUES (?, 'main', 'sender', ?, ?, 'notice', ?, ?)
            RETURNING id
        `);
        const posted = (insertMessage.get(1, null, "all", "posted", now) as { id: number }).id;
        const mislabeled = (insertMessage.get(2, null, "direct", "from an old bridge", now) as { id: number }).id;
        const direct = (insertMessage.get(3, "reader", "direct", "to the reader", now) as { id: number }).id;
        const insertReceipt = old.prepare("INSERT INTO message_receipt (message_id, agent_id) VALUES (?, 'reader')");
        for(const id of [posted, mislabeled, direct]) insertReceipt.run(id);
        old.close();

        const upgraded = await openDatabase(oldDirectory);
        try {
            const messages = new RoomStore(upgraded).getRoomOverview("main", 10).messages;
            expect(messages.map((message) => [message.id, message.posted])).toEqual([[posted, true], [mislabeled, true], [direct, false]]);
            expect(upgraded.prepare("SELECT message_id FROM message_receipt").all()).toEqual([{ message_id: direct }]);
            // version 9 counts message numbers on from the highest kept
            expect(upgraded.prepare("SELECT value FROM meta WHERE key = 'last_message_id'").get()).toEqual({ value: String(direct) });
        }
        finally { upgraded.close(); }
    });

    it("does not change version 1 when its migration backup cannot be completed", async () => {
        const oldDirectory = path.join(directory, "failed-backup");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        old.exec(SCHEMA_STEPS[0]);
        old.exec("PRAGMA user_version = 1");
        const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("backup write failed"); });
        try {
            await expect(openDatabase(oldDirectory)).rejects.toThrow(/backup failed/);
            expect(old.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
            expect(old.prepare("SELECT name FROM pragma_table_info('agent') WHERE name = 'host'").get()).toBeUndefined();
        }
        finally { rename.mockRestore(); old.close(); }
    });

    it("backs up the version 1 database including WAL data before preserving its records in the current schema", async () => {
        const oldDirectory = path.join(directory, "old");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        old.exec("PRAGMA journal_mode = WAL");
        old.exec(SCHEMA_STEPS[0]);
        old.exec("PRAGMA user_version = 1");
        old.prepare("INSERT INTO meta (key, value) VALUES ('sentinel', 'keep')").run();
        const joined = { agent_id: "legacy-agent", handle: "legacy-handle" };
        old.prepare(`INSERT INTO agent (id, room, handle_hash, display_name, client, changed_seq, joined_at, updated_at, last_seen_at)
            VALUES (?, 'dev', ?, 'legacy', 'test', 1, '2026-01-01', '2026-01-01', '2026-01-01')`)
            .run(joined.agent_id, createHash("sha256").update(joined.handle).digest("hex"));
        const upgraded = await openDatabase(oldDirectory);
        try {
            expect(upgraded.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: SCHEMA_STEPS.length });
            expect(new RoomStore(upgraded).requireAgentIdByHandle(joined.handle)).toBe(joined.agent_id);
            const name = fs.readdirSync(oldDirectory).find((file) => file.includes(".bak-v1-"))!;
            const backup = new DatabaseSync(path.join(oldDirectory, name));
            try {
                expect(backup.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
                expect(backup.prepare("SELECT value FROM meta WHERE key = 'sentinel'").get()).toMatchObject({ value: "keep" });
                expect(backup.prepare("SELECT id FROM agent").get()).toMatchObject({ id: joined.agent_id });
            }
            finally { backup.close(); }
        }
        finally { upgraded.close(); old.close(); }
    });
});

describe("renaming a card", () => {
    it("lets an agent rename its card through check_in without joining again", () => {
        const joined = start();
        store.checkIn(joined.agent_id, { cursor: null, expectedRevision: null, update: { displayName: "Dev / API 02" }, checkpoint: null, receivedMessageIds: [] });
        expect(card(joined.agent_id).name).toBe("Dev / API 02");
        store.checkIn(joined.agent_id, { cursor: null, expectedRevision: null, update: { displayName: "  " }, checkpoint: null, receivedMessageIds: [] });
        expect(card(joined.agent_id).name).toBe("Dev / API 02");
    });
});

describe("host payload adapters", () => {
    it.each(HOST_ADAPTERS)("normalizes $id sessions and never blocks on an empty output", (adapter) => {
        const payload = { session_id: "s", sessionId: "s", conversation_id: "s", cwd: directory };
        expect(adapter.normalize("session-start", payload)).toMatchObject({ host: adapter.id, sessionId: "s", cwd: directory });
        expect(adapter.output("turn-end")).toEqual({});
        expect(adapter.normalize("file-edited", { ...payload, tool_name: "Read", toolName: "view" })).toBeNull();
        expect(adapter.normalize("session-start", { ...payload, agent_id: "subagent" })).toBeNull();
        expect(() => adapter.normalize("session-start", {})).toThrow();
    });

    it("extracts successful Codex patch paths including renames and excludes failures", () => {
        const adapter = getHostAdapter("codex");
        const payload = {
            session_id: "s", cwd: directory, tool_name: "apply_patch",
            tool_input: { command: "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-foo\n+*** Update File: fake.ts\n*** Add File: c.ts\n+hi\n*** Delete File: d.ts\n*** End Patch" },
            tool_response: "Success. Updated the following files:\nM b.ts\nA c.ts\nD d.ts",
        };
        expect(adapter.normalize("file-edited", payload)?.files).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
        expect(adapter.normalize("file-edited", { ...payload, tool_response: "Failed to find expected lines" })).toBeNull();
        expect(adapter.output("session-start", "context")).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "context" } });
    });

    it("uses each host's edit payload and context output", () => {
        const base = { session_id: "s", sessionId: "s", cwd: directory };
        expect(getHostAdapter("claude").normalize("file-edited", { ...base, tool_name: "NotebookEdit", tool_input: { notebook_path: "notes.ipynb" } })?.files).toEqual(["notes.ipynb"]);
        expect(getHostAdapter("gemini").normalize("file-edited", { ...base, tool_name: "write_file", tool_input: { file_path: "file.ts" }, tool_response: {} })?.files).toEqual(["file.ts"]);
        expect(getHostAdapter("gemini").normalize("file-edited", { ...base, tool_name: "replace", tool_input: { file_path: "file.ts" }, tool_response: { error: "failed" } })).toBeNull();
        expect(getHostAdapter("copilot").normalize("file-edited", { ...base, toolName: "edit", toolArgs: JSON.stringify({ path: "file.ts" }), toolResult: { resultType: "success" } })?.files).toEqual(["file.ts"]);
        expect(getHostAdapter("cursor").normalize("file-edited", { conversation_id: "s", workspace_roots: [directory], file_path: "file.ts" })?.files).toEqual(["file.ts"]);
        expect(() => getHostAdapter("cursor").normalize("session-start", { conversation_id: "s", workspace_roots: [directory, path.dirname(directory)] })).toThrow();
        expect(getHostAdapter("cursor").output("session-start", "hi")).toEqual({ additional_context: "hi" });
        expect(getHostAdapter("copilot").output("session-start", "hi")).toEqual({ additionalContext: "hi" });
        expect(getHostAdapter("cursor").output("prompt", "hi")).toEqual({ continue: true });
        expect(getHostAdapter("copilot").output("prompt", "hi")).toEqual({});
    });
});
