import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";
import type { MessageKind } from "../src/_defs";
import { issueText, renderAgentDetail, renderRoomStatus } from "../src/modules/cli/status-renderer";
import { displayWidth } from "../src/modules/cli/prompter";
import { runMenu } from "../src/modules/cli/menu";

let directory: string;
let database: DatabaseSync;
let store: RoomStore;
let reader: string;
let reporter: string;
const SESSION = "pending-reader";
const NOW = Date.parse("2026-10-27T00:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const join = (name: string) => store.join({ displayName: name, client: "Codex", workingDirectory: directory, workspaceRoot: null, resumeHandle: null }).agent_id;
const event = (kind: "session-start" | "turn-end" | "prompt" | "session-end", canContinue?: boolean) => ({ host: "claude", sessionId: SESSION, cwd: directory, files: [], kind, canContinue });
const send = (from: string, to: string | string[], kind: MessageKind = "question", replyTo: number | null = null, text = "First preview line\nHidden second line") =>
    store.sendMessage(from, { to, kind, text, replyTo, requestId: null }).message_id;
const timestamp = (id: number, elapsed: number) => database.prepare("UPDATE message SET created_at = ? WHERE id = ?").run(ago(elapsed), id);
const overview = (id = reader) => store.getRoomOverview("main", 0).agents.find((agent) => agent.agent_id == id)!;
const warning = (id = reader) => overview(id).issues.find((issue) => issue.kind == "unread_unwoken");

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-pending-"));
    vi.stubEnv("CONCOS_HOME", directory);
    vi.stubEnv("CODEX_HOME", path.join(directory, "user", ".codex"));
    database = await openDatabase(directory);
    store = new RoomStore(database);
    reader = store.applyHookEvent({ ...event("session-start"), client: "Claude Code" })!.joined!.agent_id;
    store.checkIn(reader, { update: { displayName: "Reader" }, receivedMessageIds: [], checkpoint: null, cursor: null, expectedRevision: null });
    store.applyHookEvent(event("turn-end"));
    reporter = join("Reporter");
});
afterEach(() => {
    database.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("pending message diagnostics", () => {
    it("uses the hook's exact wake targets for direct and group messages, without listing posts or other agents' messages", () => {
        const peer = join("Peer");
        const question = send(reporter, reader);
        const group = send(reporter, [reader, peer], "notice");
        const note = send(reporter, reader, "note");
        const mine = send(reader, reporter);
        const answer = send(reporter, reader, "reply", mine);
        send(reporter, "all", "notice");
        send(reporter, peer);
        const pending = store.pendingFor(reader);
        expect(pending.map((message) => message.id)).toEqual([question, group, note, answer]);
        expect(pending.filter((message) => message.wake_target).map((message) => message.id)).toEqual(store.hookNotices(reader, 0, true).map((message) => message.id));
        expect(pending.every((message) => message.wake_reason == null)).toBe(true);
        expect(pending[0]).toMatchObject({ from: reporter, from_name: "Reporter", from_client: "Codex", from_human: false, created_at: ago(0), preview: "First preview line" });
        expect(store.pendingFor("unknown")).toEqual([]);
    });

    it.each(["note", "notice"] as const)("includes a reply to this agent's %s in wake diagnostics, while Stop still excludes it", (kind) => {
        const root = send(reader, reporter, kind);
        const reply = send(reporter, reader, "reply", root);
        timestamp(reply, 25 * 60_000);
        expect(store.hookNotices(reader, 0, true).map((message) => message.id)).toEqual([reply]);
        expect(store.hookNotices(reader, 0, false)).toEqual([]);
        expect(store.pendingFor(reader)).toMatchObject([{ id: reply, wake_target: true, wake_reason: null, notified: false }]);
        expect(warning()).toEqual({ kind: "unread_unwoken", count: 1, since: ago(25 * 60_000) });
    });

    it("keeps full-text delivery, notice position and acknowledgement separate, and queries without changing them", () => {
        const announced = send(reporter, reader, "notice");
        database.prepare("UPDATE agent SET hook_nudged_seq = (SELECT seq FROM message WHERE id = ?) WHERE id = ?").run(announced, reader);
        const delivered = send(reporter, reader);
        timestamp(announced, 25 * 60_000);
        timestamp(delivered, 20 * 60_000);
        store.markDelivered(reader, [delivered]);
        const pending = store.pendingFor(reader);
        expect(pending).toMatchObject([
            { id: announced, notified: true, delivered_at: null, wake_target: true },
            { id: delivered, notified: false, delivered_at: ago(0), wake_target: true },
        ]);
        expect(warning()).toEqual({ kind: "unread_unwoken", count: 1, since: ago(20 * 60_000) });
        expect(store.getInbox(reader)).toEqual({ questions: 1, notes: 1 });
        expect(database.prepare("SELECT received_at FROM message_receipt WHERE agent_id = ? ORDER BY message_id").all(reader)).toEqual([{ received_at: null }, { received_at: null }]);
        store.acknowledge(reader, [delivered]);
        expect(store.pendingFor(reader).map((message) => message.id)).toEqual([announced]);
        expect(warning()).toBeUndefined();
    });

    it.each([
        ["reply", true, "reply_to_your_reply"], ["reply", false, "reply_to_other_reply"],
        ["question", false, "reply_to_other_question"],
        ["note", false, "reply_to_other_note"],
        ["notice", false, "reply_to_other_notice"],
    ] as const)("explains a reply to %s, own=%s, as %s", (kind, own, reason) => {
        const peer = join("Peer");
        const author = own ? reader : reporter;
        const earlier = kind == "reply" ? send(peer, author) : null;
        const root = send(author, peer, kind, earlier);
        const reply = send(peer, reader, "reply", root);
        timestamp(reply, 25 * 60_000);
        expect(store.pendingFor(reader).find((message) => message.id == reply)).toMatchObject({ wake_target: false, wake_reason: reason, notified: false });
        expect(warning()).toBeUndefined();
    });

    it("explains a reply whose original message has gone, and keeps human sender identity", () => {
        const human = store.ensureHumanParticipant("main", "Reviewer");
        const reply = send(human, reader, "reply", 999999);
        expect(store.pendingFor(reader)).toMatchObject([{ id: reply, from_name: "Reviewer", from_human: true, wake_target: false, wake_reason: "reply_target_missing" }]);
    });
});

describe("unread without a wake", () => {
    it.each([[599999, false], [600000, false], [600001, true]] as const)("checks the ten-minute boundary at %d ms", (elapsed, flagged) => {
        const question = send(reporter, reader);
        timestamp(question, elapsed);
        expect(warning() != null).toBe(flagged);
    });

    it("counts only targets not yet notified, using their oldest arrival rather than an older excluded reply", () => {
        const announced = send(reporter, reader);
        timestamp(announced, 35 * 60_000);
        database.prepare("UPDATE agent SET hook_nudged_seq = (SELECT seq FROM message WHERE id = ?) WHERE id = ?").run(announced, reader);
        const peer = join("Peer");
        const note = send(reporter, peer, "note");
        const excluded = send(peer, reader, "reply", note);
        timestamp(excluded, 40 * 60_000);
        const older = send(reporter, reader, "notice");
        const newer = send(reporter, reader);
        timestamp(older, 25 * 60_000);
        timestamp(newer, 2 * 60_000);
        expect(warning()).toEqual({ kind: "unread_unwoken", count: 2, since: ago(25 * 60_000) });
        expect(store.pendingFor(reader).map((message) => message.id)).toEqual([excluded, announced, older, newer]);
    });

    it("does not flag a card without a host session or a session still working", () => {
        const standalone = join("Standalone");
        store.checkIn(standalone, { update: { status: "waiting" }, receivedMessageIds: [], checkpoint: null, cursor: null, expectedRevision: null });
        timestamp(send(reporter, standalone), 25 * 60_000);
        expect(store.pendingFor(standalone)[0].wake_target).toBe(true);
        expect(warning(standalone)).toBeUndefined();
        timestamp(send(reporter, reader), 25 * 60_000);
        store.applyHookEvent(event("prompt"));
        expect(warning()).toBeUndefined();
    });

    it.each(["ended", "left", "silent"])("does not flag a %s card", (state) => {
        timestamp(send(reporter, reader), 25 * 60_000);
        if(state == "ended") store.applyHookEvent(event("session-end"));
        else if(state == "left") store.leave(reader, { summary: null, nextStep: null, checkpoint: null });
        else database.prepare("UPDATE agent SET last_seen_at = ? WHERE id = ?").run(ago(31 * 60_000), reader);
        expect(warning()).toBeUndefined();
    });

    it("clears the warning after a hook points out the message even if it is still unreceived", () => {
        timestamp(send(reporter, reader), 25 * 60_000);
        expect(warning()).toBeDefined();
        store.applyHookEvent(event("turn-end", true));
        store.applyHookEvent(event("turn-end", false));
        expect(store.pendingFor(reader)[0]).toMatchObject({ notified: true, delivered_at: null });
        expect(warning()).toBeUndefined();
    });
});

describe("waiting messages on a card", () => {
    const render = (language: "en" | "ko" = "en", columns = 120, color = false) => renderAgentDetail(overview(), store.inspectAgent(reader, { agentId: reader, checkpointLimit: null, beforeCheckpointId: null }), {
        language, columns, color, nowMs: NOW, pendingMessages: store.pendingFor(reader),
    });

    it("shows sender and age, notice and full-text delivery separately, and only the first preview line", () => {
        const notified = send(reporter, reader, "notice");
        database.prepare("UPDATE agent SET hook_nudged_seq = (SELECT seq FROM message WHERE id = ?) WHERE id = ?").run(notified, reader);
        const delivered = send(reporter, reader, "question", null, "Preview \u001b[31mred\u001b[0m\nHidden second line");
        timestamp(delivered, 20 * 60_000);
        store.markDelivered(reader, [delivered]);
        const text = render();
        expect(text).toContain("Waiting messages");
        expect(text).toContain(`#${delivered} QUESTION`);
        expect(text).toContain("Reporter (Codex)");
        expect(text).toContain("20m ago");
        expect(text).toContain("Wake target · already notified");
        expect(text).toContain("Wake target · not yet notified");
        expect(text).toContain("Full text delivered just now");
        expect(text).toContain("Full text not delivered");
        expect(text).toContain("Preview red");
        expect(text).not.toContain("Hidden second line");
        expect(text).not.toContain("\u001b");
        expect(store.getInbox(reader)).toEqual({ questions: 1, notes: 1 });
    });

    it("shows the exclusion reason in both languages and keeps the detail within narrow terminal columns", () => {
        const peer = join("Peer");
        const note = send(reporter, peer, "note");
        send(peer, reader, "reply", note, "long preview ".repeat(50));
        expect(render()).toContain("Reply to someone else's note · does not wake");
        expect(render("ko")).toContain("다른 이의 note에 온 답 · 깨우지 않음");
        expect(render("ko")).toContain("미확인 메시지");
        const narrow = render("en", 40, true);
        expect(stripVTControlCharacters(narrow).split("\n").every((line) => displayWidth(line) <= 39)).toBe(true);
        expect(narrow).toContain("…");
    });

    it("shows an empty section when the board supplies no waiting messages", () => {
        expect(render()).toContain("Waiting messages\n  None");
    });

    it("includes the actionable Check line in the status report in both languages", () => {
        const question = send(reporter, reader);
        timestamp(question, 25 * 60_000);
        const issue = warning()!;
        expect(issueText(issue, NOW, true)).toBe("1 unread for 25m without a wake · type in the session");
        expect(issueText(issue, NOW, false)).toBe("미확인 1개가 25분째 깨우지 못함 · 세션에 입력하세요");
        const snapshot = store.getRoomOverview("main", 0);
        expect(renderRoomStatus(snapshot, { language: "en", columns: 120, nowMs: NOW })).toMatch(/Check\s+1 unread for 25m without a wake/);
        expect(renderRoomStatus(snapshot, { language: "ko", columns: 120, nowMs: NOW })).toContain("세션에 입력하세요");
    });

    it("opens the waiting-message section through the actual agent card without acknowledging its previews", async () => {
        const question = send(reporter, reader);
        timestamp(question, 25 * 60_000);
        const input = Readable.from(["status\nReader\nback\nback\nquit\n"]);
        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => { text += chunk.toString(); });
        await runMenu({ input, output, home: path.join(directory, "user"), selfUpdate: false });
        expect(text).toContain("Waiting messages");
        expect(text).toContain(`#${question} QUESTION`);
        expect(text).toContain("Wake target · not yet notified");
        expect(store.getInbox(reader)).toEqual({ questions: 1, notes: 0 });
    });
});
