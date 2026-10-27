import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WAKE_FALLBACK_MS } from "../src/_defs";
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

    it("keeps the folder a session first started in through joins and resumes from other folders", () => {
        const joined = start();
        const docs = path.join(directory, "docs-repo");
        fs.mkdirSync(docs);
        store.join({ room: "main", displayName: "Designer", client: "Claude Code", workingDirectory: docs, workspaceRoot: null, resumeHandle: joined.handle });
        expect(card(joined.agent_id)).toMatchObject({ working_directory: directory, current_directory: docs });
        // resumed or compacted after a cd: the session start's folder is where it works now
        store.applyHookEvent(event("session-start", { cwd: docs }), "dev");
        expect(card(joined.agent_id)).toMatchObject({ working_directory: directory, workspace: { path: directory }, current_directory: docs });
        store.applyHookEvent(event("session-start"), "dev");
        expect(card(joined.agent_id).current_directory).toBeUndefined();
        // a new session is a new card, with the folder it starts in
        const fresh = start({ sessionId: "session-2", cwd: docs });
        expect(card(fresh.agent_id)).toMatchObject({ working_directory: docs });
    });

    it("does not create participants on late events or revive an explicitly left participant", () => {
        expect(store.applyHookEvent(event("turn-end"), "dev")).toBeNull();
        expect(store.applyHookEvent(event("file-edited", { files: ["x.ts"] }), "dev")).toBeNull();
        const joined = start();
        store.leave(joined.agent_id, { summary: null, nextStep: null, checkpoint: null });
        expect(store.applyHookEvent(event("file-edited", { files: ["x.ts"] }), "dev")).toBeNull();
        expect(store.applyHookEvent(event("prompt"), "dev")).toBeNull();
        expect(card(joined.agent_id).left).toBe(true);
    });

    it("gives a session whose hooks came on after it started a card at its first prompt, which its own card can take over", () => {
        // the model joined by itself while no hook knew the session
        const earlier = store.join({ room: "main", displayName: "ADX/CONCOS02", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const prompt = event("prompt", { host: "codex", client: "Codex" });
        const result = processHook(store, prompt, "dev");
        expect(result?.context).toContain("this session's name as display_name");
        const handle = /handle=([\w-]+)/.exec(result?.context ?? "")?.[1] ?? "";
        // joining under the session's name with that handle: the earlier card takes the session over
        const named = store.join({ room: "main", displayName: "ADX/CONCOS02", client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: handle });
        expect(named).toMatchObject({ agent_id: earlier.agent_id, merged_from: expect.any(String) });
        expect(store.applyHookEvent(event("turn-end", { host: "codex" }), "dev")?.agentId).toBe(earlier.agent_id);
        expect(card(earlier.agent_id).status).toBe("waiting");
        // a session the hooks know: its prompt names only what is unread
        expect(processHook(store, prompt, "dev")).toBeUndefined();
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
        // notes and notices are named too; an answer to another's question is only counted
        expect(output?.context).toBe(`concos: unread for you — question #${question.message_id} from human; note #${sent[0]} from human; notice #${sent[1]} from human; plus 1 other unread. Read them with read_messages.`);
        expect(database.prepare("SELECT delivered_seq FROM agent WHERE id = ?").get(joined.agent_id)).toEqual(before);
        expect(store.getInbox(joined.agent_id)).toEqual({ questions: 1, notes: 3 });
        store.checkIn(joined.agent_id, { update: {}, receivedMessageIds: [question.message_id, sent[0], sent[1]], cursor: null, expectedRevision: null, checkpoint: null });
        expect(processHook(store, event("prompt"), "dev")?.context).toBe("concos: unread for you — 1 message. Read them with read_messages.");
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

describe("recent edited folders", () => {
    it("keeps three distinct workspace-relative folders in edit order and refreshes repeats", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            vi.setSystemTime("2026-10-27T09:00:00.000Z");
            const joined = start();
            store.applyHookEvent(event("file-edited", { files: ["src/a.ts", "README.md", "docs/a.md", "tests/a.ts"] }));
            expect(card(joined.agent_id).recent_folders).toEqual([
                { path: "tests", at: "2026-10-27T09:00:00.000Z" },
                { path: "docs", at: "2026-10-27T09:00:00.000Z" },
                { path: ".", at: "2026-10-27T09:00:00.000Z" },
            ]);
            vi.setSystemTime("2026-10-27T09:01:00.000Z");
            store.applyHookEvent(event("file-edited", { cwd: path.join(directory, "src"), files: ["../docs/b.md", path.join(directory, "README.md")] }));
            const folders = [
                { path: ".", at: "2026-10-27T09:01:00.000Z" },
                { path: "docs", at: "2026-10-27T09:01:00.000Z" },
                { path: "tests", at: "2026-10-27T09:00:00.000Z" },
            ];
            expect(card(joined.agent_id).recent_folders).toEqual(folders);
            expect(store.getRoomOverview("main", 10).agents.find((agent) => agent.agent_id == joined.agent_id)?.recent_folders).toEqual(folders);
        }
        finally { vi.useRealTimers(); }
    });

    it("keeps outside-project edits as claims without replacing recent folders", () => {
        const joined = start();
        store.applyHookEvent(event("file-edited", { files: [path.join(directory, "..", "outside", "a.ts")] }));
        expect(card(joined.agent_id)).toMatchObject({ editing: ["../outside/a.ts"], recent_folders: [] });
        // A name beginning with two dots is still inside the project unless it is a parent segment.
        store.applyHookEvent(event("file-edited", { files: ["..internal/a.ts"] }));
        const folders = card(joined.agent_id).recent_folders;
        expect(folders[0].path).toBe("..internal");
        const files = [path.join(directory, "..", "outside", "b.ts")];
        if(process.platform == "win32") {
            const otherDrive = path.parse(directory).root[0].toUpperCase() == "C" ? "D" : "C";
            files.push(`${otherDrive}:/outside/c.ts`);
        }
        store.applyHookEvent(event("file-edited", { files }));
        expect(card(joined.agent_id).recent_folders).toEqual(folders);
        expect(card(joined.agent_id).editing).toContain("../outside/b.ts");
        if(process.platform == "win32") expect(card(joined.agent_id).editing).toContain(files[1]);
    });

    it("records only edit hooks and adds no check_in payload or change sequence for a repeated file", () => {
        const joined = start();
        const reader = store.join({ displayName: "Reader", client: "test", workingDirectory: directory, workspaceRoot: null, resumeHandle: null });
        const check = (agentId: string, editing?: string[]) => store.checkIn(agentId, {
            update: editing == null ? {} : { editing }, receivedMessageIds: [], checkpoint: null, cursor: null, expectedRevision: null,
        });
        check(joined.agent_id, ["claimed/a.ts"]);
        expect(card(joined.agent_id).recent_folders).toEqual([]);
        const empty = check(reader.agent_id);
        expect(empty.agents!.find((agent) => agent.agent_id == joined.agent_id)).not.toHaveProperty("recent_folders");
        store.applyHookEvent(event("file-edited", { files: ["src/a.ts"] }));
        expect(check(reader.agent_id).agents!.find((agent) => agent.agent_id == joined.agent_id)).not.toHaveProperty("recent_folders");
        const state = () => database.prepare("SELECT revision, changed_seq, content_changed_seq, updated_at, editing_updated_at FROM agent WHERE id = ?").get(joined.agent_id);
        const before = state();
        const folders = card(joined.agent_id).recent_folders;
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            vi.setSystemTime(Date.parse(folders[0].at) + 1000);
            store.applyHookEvent(event("file-edited", { files: ["src/a.ts"] }));
        }
        finally { vi.useRealTimers(); }
        expect(card(joined.agent_id).recent_folders[0].at).not.toBe(folders[0].at);
        expect(state()).toEqual(before);
        expect(check(reader.agent_id).agents).toBeUndefined();
        store.applyHookEvent(event("file-edited"));
        expect(state()).toEqual(before);
    });

    it("keeps folders through turn end, bridge restart and compaction, then clears on session end or leave", () => {
        const joined = start();
        store.applyHookEvent(event("file-edited", { files: ["src/a.ts"] }));
        const folders = card(joined.agent_id).recent_folders;
        store.applyHookEvent(event("turn-end"));
        expect(card(joined.agent_id)).toMatchObject({ editing: [], recent_folders: folders });
        store.disconnect([joined.agent_id]);
        start();
        expect(card(joined.agent_id).recent_folders).toEqual(folders);
        store.applyHookEvent(event("session-end"));
        expect(card(joined.agent_id).recent_folders).toEqual([]);
        start();
        store.applyHookEvent(event("file-edited", { files: ["docs/a.md"] }));
        store.leave(joined.agent_id, { summary: null, nextStep: null, checkpoint: null });
        expect(card(joined.agent_id).recent_folders).toEqual([]);
        expect(store.applyHookEvent(event("file-edited", { files: ["late/a.ts"] }))).toBeNull();
    });

    it("transfers hook folders to the named card and rebases them when the project root moves", () => {
        const nested = path.join(directory, "repo");
        fs.mkdirSync(nested);
        const earlier = store.join({ displayName: "Named", client: "test", workingDirectory: nested, workspaceRoot: null, resumeHandle: null });
        const hooked = start({ cwd: nested });
        store.applyHookEvent(event("file-edited", { cwd: nested, files: ["README.md", "src/a.ts"] }));
        const folders = card(hooked.agent_id).recent_folders;
        const merged = store.join({ displayName: "Named", client: "test", workingDirectory: nested, workspaceRoot: null, resumeHandle: hooked.handle });
        expect(merged.agent_id).toBe(earlier.agent_id);
        expect(card(merged.agent_id).recent_folders).toEqual(folders);
        store.join({ displayName: "Named", client: "test", workingDirectory: nested, workspaceRoot: directory, resumeHandle: hooked.handle });
        expect(card(merged.agent_id).recent_folders).toEqual([
            { path: "repo/src", at: folders[0].at }, { path: "repo", at: folders[1].at },
        ]);
        store.applyHookEvent(event("file-edited", { cwd: nested, files: ["src/b.ts"] }));
        expect(card(merged.agent_id).recent_folders.map((folder) => folder.path)).toEqual(["repo/src", "repo"]);
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

    it("receives at the turn end what went out in full during the turn, and continues only for the rest", () => {
        const joined = start();
        const asker = joinOther("Asker");
        const read = send(asker.agent_id, joined.agent_id);
        const previewed = send(asker.agent_id, joined.agent_id);
        // read_messages gave the first one whole; the second showed only as a cut preview
        store.markDelivered(joined.agent_id, [read]);
        expect(turnEnd(true)?.continueFor?.map((notice) => notice.id)).toEqual([previewed]);
        expect(store.getInbox(joined.agent_id)).toEqual({ questions: 1, notes: 0 });
        // a turn end that does not continue receives too
        store.markDelivered(joined.agent_id, [previewed]);
        turnEnd(false);
        expect(store.getInbox(joined.agent_id)).toBeUndefined();
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

    it("wakes for a note or notice named to the session too, but never for a post to the room", () => {
        const joined = start();
        const from = asker();
        const live = watch();
        store.sendMessage(from, { to: "all", kind: "notice", text: "for reference", replyTo: null, requestId: null });
        expect(store.checkWakeWatch(live, true)).toEqual({ state: "wait" });
        const note = store.sendMessage(from, { to: joined.agent_id, kind: "notice", text: "report", replyTo: null, requestId: null }).message_id;
        expect(store.checkWakeWatch(live, true)).toMatchObject({ state: "wake", notices: [{ id: note, kind: "notice" }] });
        // a turn end still continues only for questions and answers
        store.sendMessage(from, { to: joined.agent_id, kind: "note", text: "fyi", replyTo: null, requestId: null });
        expect(store.applyHookEvent(event("turn-end", { canContinue: true }), "dev")?.continueFor).toBeUndefined();
    });

    it.each(["note", "notice"] as const)("receives a %s read as the woken turn's last call when its guarded Stop runs", async (kind) => {
        const joined = start();
        const from = asker();
        const delivered = store.sendMessage(from, { to: joined.agent_id, kind, text: "read this whole message", replyTo: null, requestId: null }).message_id;
        const reminded = store.sendMessage(from, { to: joined.agent_id, kind: "note", text: "only named by the reminder", replyTo: null, requestId: null }).message_id;
        expect(store.checkWakeWatch(watch(), true)).toMatchObject({ state: "wake", notices: [{ id: delivered }, { id: reminded }] });
        store.applyHookEvent(event("prompt"), "dev");

        // The woken model reads one whole message, then makes no further MCP call. Its bridge
        // records delivery; a separate Stop process must receive it even with stop_hook_active.
        const bridge = await openDatabase(directory);
        try {
            const bridgeStore = new RoomStore(bridge);
            const result = bridgeStore.readMessages(joined.agent_id, { messageIds: [delivered], limit: null });
            expect(result.messages.map((message) => message.id)).toEqual([delivered]);
            bridgeStore.markDelivered(joined.agent_id, result.messages.map((message) => message.id));
        }
        finally { bridge.close(); }
        expect(store.getInbox(joined.agent_id)).toEqual({ questions: 0, notes: 2 });
        const stop = getHostAdapter("claude").normalize("turn-end", {
            session_id: "session-1", cwd: directory, stop_hook_active: true,
        })!;
        expect(stop.canContinue).toBe(false);
        expect(processHook(store, stop, "dev")).toBeUndefined();
        expect(card(joined.agent_id).status).toBe("waiting");
        expect(store.getInbox(joined.agent_id)).toEqual({ questions: 0, notes: 1 });
        expect(store.readMessages(joined.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([reminded]);
        expect(store.checkWakeWatch(watch(), true)).toEqual({ state: "wait" });
    });

    it("keeps an answer to an answer unread without waking the session for it", () => {
        const joined = start();
        const from = asker();
        const question = ask(joined.agent_id, from);
        const answer = store.sendMessage(from, { to: joined.agent_id, kind: "reply", text: "answer", replyTo: question, requestId: null }).message_id;
        const thanks = store.sendMessage(joined.agent_id, { to: from, kind: "reply", text: "thanks", replyTo: answer, requestId: null }).message_id;
        const followUp = store.sendMessage(from, { to: joined.agent_id, kind: "reply", text: "acknowledged", replyTo: thanks, requestId: null }).message_id;
        expect(store.hookNotices(joined.agent_id, 0, true).map((notice) => notice.id)).toEqual([answer]);
        store.acknowledge(joined.agent_id, [answer]);
        expect(store.readMessages(joined.agent_id, { messageIds: null, limit: null }).messages.map((message) => message.id)).toEqual([followUp]);
        expect(store.checkWakeWatch(watch(), true)).toEqual({ state: "wait" });
    });

    it.each(["note", "notice"] as const)("wakes for an answer to its own %s, which a turn end does not continue for", (kind) => {
        const joined = start();
        const from = asker();
        const handedOver = store.sendMessage(joined.agent_id, { to: from, kind, text: "please do this", replyTo: null, requestId: null }).message_id;
        const result = store.sendMessage(from, { to: joined.agent_id, kind: "reply", text: "done", replyTo: handedOver, requestId: null }).message_id;
        expect(store.applyHookEvent(event("turn-end", { canContinue: true }), "dev")?.continueFor).toBeUndefined();
        expect(store.checkWakeWatch(watch(), true)).toMatchObject({ state: "wake", notices: [{ id: result, kind: "reply" }] });
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

    it("wakes a session for every new message with no hourly limit, keeping the last hour's wake times", () => {
        const joined = start();
        const from = asker();
        const nowMs = Date.now();
        for(let index = 0; index < 6; index += 1) {
            ask(from, joined.agent_id);
            expect(store.checkWakeWatch(watch(), true, nowMs + index * 1000).state).toBe("wake");
        }
        ask(from, joined.agent_id);
        expect(store.checkWakeWatch(watch(), true, nowMs + 60 * 60 * 1000 + 2500).state).toBe("wake");
        // the wakes at +0, +1 and +2 seconds are over an hour old by then
        const row = database.prepare("SELECT woken_at_list FROM agent WHERE id = ?").get(joined.agent_id) as { woken_at_list: string };
        expect(JSON.parse(row.woken_at_list)).toHaveLength(4);
    });

    it("keeps a session's card connected, and its watch going, when one of its MCP servers exits", () => {
        const joined = start();
        const live = watch();
        // a client restarting its MCP server within the open session
        store.disconnect([joined.agent_id]);
        expect(database.prepare("SELECT disconnected_at FROM agent WHERE id = :id").get({ id: joined.agent_id })).toEqual({ disconnected_at: null });
        expect(store.checkWakeWatch(live, true)).toEqual({ state: "wait" });
        // the session's own end still ends it
        store.applyHookEvent(event("session-end"), "dev");
        expect(store.checkWakeWatch(live, true)).toEqual({ state: "stop" });
    });

    it("tells of the other unread messages in the wake line, so the woken turn reads them too", async () => {
        const joined = start();
        const from = asker();
        // an answer to the session's answer wakes nobody, but stays unread
        const note = store.sendMessage(from, { to: joined.agent_id, kind: "note", text: "fyi", replyTo: null, requestId: null }).message_id;
        store.acknowledge(joined.agent_id, [note]);
        const thanks = store.sendMessage(joined.agent_id, { to: from, kind: "reply", text: "thanks", replyTo: note, requestId: null }).message_id;
        store.sendMessage(from, { to: joined.agent_id, kind: "reply", text: "noted", replyTo: thanks, requestId: null });
        const waking = watchForWake(store, event("watch"), { idleMs: 0, pollMs: 5, watchMs: 2000 });
        setTimeout(() => ask(from, joined.agent_id), 30);
        expect(await waking).toMatch(/^concos: unread for you — question #\d+ from Asker; plus 1 other unread\. Read them with read_messages/);
        expect(processHook(store, event("prompt"), "dev")?.context).toMatch(/question #\d+ from Asker; plus 1 other unread\./);
    });

    it("keeps the waiting card online while it watches, and ends once the client that ran it is gone", async () => {
        const joined = start();
        database.prepare("UPDATE agent SET last_seen_at = :old WHERE id = :id").run({ old: "2026-01-01T00:00:00.000Z", id: joined.agent_id });
        // stands in for the Claude Code process that started the watch, then quits
        const client = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore" });
        const startedMs = Date.now();
        expect(await watchForWake(store, event("watch"), { idleMs: 0, pollMs: 10, watchMs: 10_000, keepAliveMs: 0 }, { keepOnline: true, parentPid: client.pid })).toBeNull();
        expect(Date.now() - startedMs).toBeLessThan(5000);
        const seen = database.prepare("SELECT last_seen_at FROM agent WHERE id = :id").get({ id: joined.agent_id }) as { last_seen_at: string };
        expect(Date.now() - Date.parse(seen.last_seen_at)).toBeLessThan(5000);
    });

    it("does not keep the card online for a parent already gone when the watch starts, but still watches", async () => {
        const joined = start();
        database.prepare("UPDATE agent SET last_seen_at = :old WHERE id = :id").run({ old: "2026-01-01T00:00:00.000Z", id: joined.agent_id });
        // a launcher that ran the watch and left: nothing vouches for the session any more
        const launcher = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
        await new Promise((resolve) => launcher.once("exit", resolve));
        const waking = watchForWake(store, event("watch"), { idleMs: 0, pollMs: 5, watchMs: 2000, keepAliveMs: 0 }, { keepOnline: true, parentPid: launcher.pid });
        setTimeout(() => ask(asker(), joined.agent_id), 50);
        expect(await waking).toMatch(/^concos: unread for you — question #\d+ from Asker\./);
        expect(database.prepare("SELECT last_seen_at FROM agent WHERE id = :id").get({ id: joined.agent_id })).toEqual({ last_seen_at: "2026-01-01T00:00:00.000Z" });
        // started through a shell, which outlives a killed client: the watch only wakes
        expect(await watchForWake(store, event("watch"), { idleMs: 0, pollMs: 5, watchMs: 100, keepAliveMs: 0 }, { keepOnline: false })).toBeNull();
        expect(database.prepare("SELECT last_seen_at FROM agent WHERE id = :id").get({ id: joined.agent_id })).toEqual({ last_seen_at: "2026-01-01T00:00:00.000Z" });
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

describe("Codex idle wake", () => {
    const codex = getHostAdapter("codex");
    const THREAD_ID = "01a16d85-083e-7373-9dd6-6ae1676b6d7c";

    it("watches in the background and hands the wake line to the session with codex queue", async () => {
        expect(codex.wake).toEqual({ event: "Stop", kind: "watch", timeout: 3660, async: true });
        // a stand-in codex first on PATH writes down what it was given
        const bin = path.join(directory, "bin");
        fs.mkdirSync(bin);
        const record = path.join(bin, "args.json");
        fs.writeFileSync(path.join(bin, "fake-codex.cjs"), `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));`);
        if(process.platform == "win32") {
            fs.writeFileSync(path.join(bin, "codex.cmd"), `@"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
        }
        else {
            fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.cjs" "$@"\n`, { mode: 0o755 });
        }
        const line = `concos: unread for you — question #7 from A&B "Ops" 100% [ops_deploy]. Read them with read_messages.`;
        vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
        try {
            await codex.deliverWake!(THREAD_ID, line);
        }
        finally { vi.unstubAllEnvs(); }
        // cmd.exe still reads " and % inside quotes, so on Windows the line goes without them
        const delivered = process.platform == "win32"
            ? `concos: unread for you — question #7 from A&B 'Ops' 100 [ops_deploy]. Read them with read_messages.`
            : line;
        expect(JSON.parse(fs.readFileSync(record, "utf8"))).toEqual(["queue", "--thread", THREAD_ID, "--message", delivered]);
    });

    it("refuses a session id that is not a Codex thread id, before running anything", async () => {
        await expect(codex.deliverWake!("session-1 & calc", "line")).rejects.toThrow(/invalid Codex session id/);
    });

    const asker = () => store.join({ room: "main", displayName: "Asker", client: "Claude Code", workingDirectory: directory, workspaceRoot: null, resumeHandle: null }).agent_id;
    const ask = (from: string, to: string) => store.sendMessage(from, { to, kind: "question", text: "body", replyTo: null, requestId: null }).message_id;
    // runs `act` with the clock at `ms`
    const at = <T>(ms: number, act: () => T): T => {
        vi.useFakeTimers({ now: ms, toFake: ["Date"] });
        try {
            return act();
        }
        finally { vi.useRealTimers(); }
    };
    // a live session's own server keeps its card online with a heartbeat
    const online = (agentId: string, ms: number) => at(ms, () => store.keepAlive(agentId));

    it("lets the MCP server wake a session no watch woke, once the message and the agent have been quiet long enough", () => {
        const session = { host: "codex", sessionId: THREAD_ID } as const;
        const joined = start(session);
        const from = asker();
        const live = store.startWakeWatch(event("watch", session))!;
        // a failed turn: the prompt came and the Stop hook never did, so the card stays working
        store.applyHookEvent(event("prompt", session), "dev");
        const question = ask(from, joined.agent_id);
        const nowMs = Date.now();
        online(joined.agent_id, nowMs + WAKE_FALLBACK_MS - 5000);
        expect(store.fallbackWake(joined.agent_id, ["codex"], nowMs + WAKE_FALLBACK_MS - 5000)).toBeNull();
        online(joined.agent_id, nowMs + WAKE_FALLBACK_MS + 1000);
        expect(store.fallbackWake(joined.agent_id, ["claude"], nowMs + WAKE_FALLBACK_MS + 1000)).toBeNull();
        expect(store.fallbackWake(joined.agent_id, ["codex"], nowMs + WAKE_FALLBACK_MS + 1000)).toEqual({
            host: "codex", sessionId: THREAD_ID, notices: [expect.objectContaining({ id: question })], unread: 1,
        });
        // pointed out once, by one of them: the fallback does not come back to it and older watches end
        expect(store.fallbackWake(joined.agent_id, ["codex"], nowMs + WAKE_FALLBACK_MS + 2000)).toBeNull();
        expect(store.checkWakeWatch(live, true)).toEqual({ state: "stop" });
        expect(card(joined.agent_id).status).toBe("working");
    });

    it("leaves the wake to the watch while the agent acts or the message is new", () => {
        const joined = start({ host: "codex", sessionId: THREAD_ID });
        const from = asker();
        const nowMs = Date.now();
        // a message that came after a long quiet is still new
        at(nowMs + WAKE_FALLBACK_MS, () => ask(from, joined.agent_id));
        online(joined.agent_id, nowMs + WAKE_FALLBACK_MS + 1000);
        expect(store.fallbackWake(joined.agent_id, ["codex"], nowMs + WAKE_FALLBACK_MS + 1000)).toBeNull();
        // the agent acts late in the period: the clock starts again from its last call
        at(nowMs + 2 * WAKE_FALLBACK_MS - 1000, () => store.recordCall(joined.agent_id));
        expect(store.fallbackWake(joined.agent_id, ["codex"], nowMs + 2 * WAKE_FALLBACK_MS + 1000)).toBeNull();
        online(joined.agent_id, nowMs + 3 * WAKE_FALLBACK_MS);
        expect(store.fallbackWake(joined.agent_id, ["codex"], nowMs + 3 * WAKE_FALLBACK_MS)).not.toBeNull();
    });

    it("leaves an offline card alone, since its session may have closed without its end hook", () => {
        const joined = start({ host: "codex", sessionId: THREAD_ID });
        ask(asker(), joined.agent_id);
        const later = Date.now() + WAKE_FALLBACK_MS + 1000;
        expect(store.fallbackWakeCandidates(["codex"], later)).toEqual([]);
        expect(store.fallbackWake(joined.agent_id, ["codex"], later)).toBeNull();
    });

    it("finds every online, quiet session of a host it can wake, whichever server they joined through", () => {
        const first = start({ host: "codex", sessionId: THREAD_ID });
        const second = start({ host: "codex", sessionId: "01a16d85-083e-7373-9dd6-6ae1676b6d7d" });
        const busy = start({ host: "codex", sessionId: "01a16d85-083e-7373-9dd6-6ae1676b6d7e" });
        const claude = start({ sessionId: "claude-session" });
        const from = asker();
        for(const card of [first, second, busy, claude]) {
            ask(from, card.agent_id);
        }
        const later = Date.now() + WAKE_FALLBACK_MS + 1000;
        for(const card of [first, second, busy, claude]) {
            online(card.agent_id, later);
        }
        // one that called concos a minute ago is still at work
        at(later - 60 * 1000, () => store.recordCall(busy.agent_id));
        expect(store.fallbackWakeCandidates(["codex"], later)).toEqual([first.agent_id, second.agent_id].sort());
        expect(store.fallbackWakeCandidates([], later)).toEqual([]);
        const woken = store.fallbackWakeCandidates(["codex"], later).map((agentId) => store.fallbackWake(agentId, ["codex"], later)?.sessionId);
        expect(woken.sort()).toEqual([THREAD_ID, "01a16d85-083e-7373-9dd6-6ae1676b6d7d"]);
    });
});

describe("schema migration", () => {
    it("adds empty folders to version 13 without changing records and lets older writers clear them", async () => {
        const oldDirectory = path.join(directory, "version13");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        old.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
        for(const step of SCHEMA_STEPS.slice(0, 13)) old.exec(step);
        old.exec("PRAGMA user_version = 13");
        const now = new Date().toISOString();
        const insert = old.prepare(`
            INSERT INTO agent (id, room, handle_hash, display_name, client, changed_seq, joined_at, updated_at, last_seen_at)
            VALUES (?, 'main', ?, ?, 'legacy', 1, ?, ?, ?)
        `);
        insert.run("legacy", "legacy-hash", "Legacy", now, now, now);
        old.exec("INSERT INTO card_delivery VALUES ('legacy', 'legacy', 1)");
        const before = old.prepare("SELECT * FROM agent").get();
        const delivery = old.prepare("SELECT * FROM card_delivery").all();
        // Prepared on the old schema, then used after another connection migrates it.
        const end = old.prepare("UPDATE agent SET editing_list = '[]', disconnected_at = ? WHERE id = 'legacy'");
        const leave = old.prepare("UPDATE agent SET editing_list = '[]', left_at = ? WHERE id = 'legacy'");
        const upgraded = await openDatabase(oldDirectory);
        try {
            expect(upgraded.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 14 });
            expect(upgraded.prepare("SELECT * FROM agent").get()).toEqual({ ...before, recent_folder_list: "[]" });
            expect(upgraded.prepare("SELECT * FROM card_delivery").all()).toEqual(delivery);
            const folders = JSON.stringify([{ path: "src", at: now }]);
            const setFolders = upgraded.prepare("UPDATE agent SET recent_folder_list = ? WHERE id = 'legacy'");
            const get = () => upgraded.prepare("SELECT recent_folder_list, changed_seq, content_changed_seq FROM agent WHERE id = 'legacy'").get();
            setFolders.run(folders);
            end.run(null);
            expect(get()).toEqual({ recent_folder_list: folders, changed_seq: 1, content_changed_seq: 1 });
            end.run(now);
            expect(get()).toEqual({ recent_folder_list: "[]", changed_seq: 1, content_changed_seq: 1 });
            end.run(null);
            setFolders.run(folders);
            leave.run(now);
            expect(get()).toEqual({ recent_folder_list: "[]", changed_seq: 1, content_changed_seq: 1 });
            insert.run("new-old-card", "new-old-hash", "New old card", now, now, now);
            expect(old.prepare("SELECT recent_folder_list FROM agent WHERE id = 'new-old-card'").get()).toEqual({ recent_folder_list: "[]" });
            expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            const backupName = fs.readdirSync(oldDirectory).find((name) => name.includes(".bak-v13-"))!;
            const backup = new DatabaseSync(path.join(oldDirectory, backupName));
            try {
                expect(backup.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 13 });
                expect(backup.prepare("SELECT * FROM agent").get()).toEqual(before);
                expect(backup.prepare("SELECT * FROM card_delivery").all()).toEqual(delivery);
            }
            finally { backup.close(); }
        }
        finally { upgraded.close(); old.close(); }
    });

    it("preserves version 12 records and tracks already-open writers through content, resume and deletion", async () => {
        const oldDirectory = path.join(directory, "version12");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        old.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON");
        for(const step of SCHEMA_STEPS.slice(0, 12)) old.exec(step);
        old.exec("PRAGMA user_version = 12");
        const now = new Date().toISOString();
        const insert = old.prepare(`
            INSERT INTO agent (id, room, handle_hash, display_name, client, changed_seq, role, joined_at, updated_at, last_seen_at, last_call_at)
            VALUES (?, 'main', ?, ?, 'legacy', ?, 'original role', ?, ?, ?, ?)
        `);
        insert.run("legacy", "legacy-hash", "Legacy", 1, now, now, now, now);
        insert.run("reader", "reader-hash", "Reader", 2, now, now, now, now);
        old.prepare("INSERT INTO checkpoint (agent_id, body, created_at) VALUES ('legacy', 'old checkpoint', ?)").run(now);
        old.prepare("INSERT INTO message (id, seq, room, sender_agent_id, recipient_agent_id, kind, body, created_at) VALUES (1, 3, 'main', 'legacy', 'reader', 'note', 'keep message', ?)").run(now);
        old.prepare("INSERT INTO message_receipt (message_id, agent_id, received_at) VALUES (1, 'reader', ?)").run(now);
        old.exec("UPDATE meta SET value = '3' WHERE key = 'last_seq'");
        const messageBefore = old.prepare("SELECT * FROM message").all();
        const receiptsBefore = old.prepare("SELECT * FROM message_receipt").all();
        const checkpointsBefore = old.prepare("SELECT * FROM checkpoint").all();
        const upgraded = await openDatabase(oldDirectory);
        try {
            expect(upgraded.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: SCHEMA_STEPS.length });
            expect(upgraded.prepare("SELECT id, changed_seq, content_changed_seq FROM agent ORDER BY changed_seq").all()).toEqual([
                { id: "legacy", changed_seq: 1, content_changed_seq: 1 }, { id: "reader", changed_seq: 2, content_changed_seq: 2 },
            ]);
            expect(upgraded.prepare("SELECT * FROM message").all()).toEqual(messageBefore);
            expect(upgraded.prepare("SELECT * FROM message_receipt").all()).toEqual(receiptsBefore);
            expect(upgraded.prepare("SELECT * FROM checkpoint").all()).toEqual(checkpointsBefore);
            expect(upgraded.prepare("SELECT * FROM card_delivery").all()).toEqual([]);
            const backupName = fs.readdirSync(oldDirectory).find((name) => name.includes(".bak-v12-"))!;
            const backup = new DatabaseSync(path.join(oldDirectory, backupName));
            try {
                expect(backup.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 12 });
                expect(backup.prepare("SELECT * FROM message").all()).toEqual(messageBefore);
            }
            finally { backup.close(); }

            const current = new RoomStore(upgraded);
            const check = (id: string) => current.checkIn(id, { cursor: null, expectedRevision: null, update: {}, checkpoint: null, receivedMessageIds: [] });
            expect(check("reader").agents![0].role).toBe("original role");
            const nextSeq = () => (old.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'last_seq' RETURNING CAST(value AS INTEGER) AS seq").get() as { seq: number }).seq;
            // The same schema-12 connection remains open; these statements omit the new column.
            old.prepare("UPDATE agent SET role = 'changed by old bridge', changed_seq = ? WHERE id = 'legacy'").run(nextSeq());
            expect(check("reader").agents![0]).toMatchObject({ role: "changed by old bridge", checkpoint: "old checkpoint" });
            old.prepare("UPDATE agent SET role = 'changed by old bridge', status = 'waiting', changed_seq = ? WHERE id = 'legacy'").run(nextSeq());
            expect(check("reader").agents![0].detail).toBe("status");
            old.prepare("UPDATE agent SET changed_seq = ? WHERE id = 'legacy'").run(nextSeq());
            old.prepare("INSERT INTO checkpoint (agent_id, body, created_at) VALUES ('legacy', 'new checkpoint', ?)").run(now);
            expect(check("reader").agents![0]).toMatchObject({ role: "changed by old bridge", checkpoint: "new checkpoint" });

            old.exec("UPDATE agent SET client = client, working_directory = working_directory WHERE id = 'reader'");
            expect(check("reader").agents![0]).toMatchObject({ role: "changed by old bridge" });
            insert.run("merging", "merging-hash", "Merging", nextSeq(), now, now, now, now);
            old.prepare("INSERT INTO checkpoint (agent_id, body, created_at) VALUES ('merging', 'transferred checkpoint', ?)").run(now);
            check("reader");
            old.exec("UPDATE checkpoint SET agent_id = 'legacy' WHERE agent_id = 'merging'");
            old.prepare("UPDATE agent SET changed_seq = ? WHERE id = 'legacy'").run(nextSeq());
            old.exec("DELETE FROM agent WHERE id = 'merging'");
            expect(check("reader").agents![0]).toMatchObject({ checkpoint: "transferred checkpoint" });
            expect(upgraded.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
            expect(upgraded.prepare("SELECT * FROM card_delivery WHERE viewer_agent_id = 'merging' OR agent_id = 'merging'").all()).toEqual([]);
        }
        finally { upgraded.close(); old.close(); }
    });

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

    it("keeps only the backup taken before this migration, removing earlier schemas' backups", async () => {
        const oldDirectory = path.join(directory, "many-backups");
        fs.mkdirSync(oldDirectory);
        const old = new DatabaseSync(path.join(oldDirectory, "concos.db"));
        for(const step of SCHEMA_STEPS.slice(0, 9)) old.exec(step);
        old.exec("PRAGMA user_version = 9");
        old.close();
        const earlier = ["concos.db.bak-v10-2026-10-01T00-00-00-000Z", "concos.db.bak-v8-2026-09-01T00-00-00-000Z", "concos.db.bak-v7-2026-08-01T00-00-00-000Z"];
        for(const name of earlier) fs.writeFileSync(path.join(oldDirectory, name), "copy");
        const upgraded = await openDatabase(oldDirectory);
        upgraded.close();
        const kept = fs.readdirSync(oldDirectory).filter((name) => name.includes(".bak-v"));
        expect(kept).toHaveLength(1);
        expect(kept[0]).toMatch(/^concos\.db\.bak-v9-/);
        // every name carries only characters every file system accepts
        expect(kept[0]).toMatch(/^[\w.-]+$/);
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
