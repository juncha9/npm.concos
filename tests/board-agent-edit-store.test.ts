import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_DISPLAY_NAME_LENGTH, MAX_ROLE_LENGTH } from "../src/_defs";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";

let directory: string;
let database: DatabaseSync;
let store: RoomStore;

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-board-edit-"));
    database = await openDatabase(directory);
    store = new RoomStore(database);
});

afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function join(name: string, project = "project") {
    return store.join({ displayName: name, client: "test", workingDirectory: path.join(directory, project), workspaceRoot: null, resumeHandle: null });
}

function checkIn(agentId: string, update: Parameters<RoomStore["checkIn"]>[1]["update"] = {}) {
    return store.checkIn(agentId, { update, cursor: null, expectedRevision: null, checkpoint: null, receivedMessageIds: [] });
}

function card(agentId: string) {
    return database.prepare(`
        SELECT display_name, role, status, editing_list, revision, changed_seq, content_changed_seq,
            updated_at, last_seen_at, last_call_at, editing_updated_at, disconnected_at, left_at
        FROM agent WHERE id = :id
    `).get({ id: agentId })!;
}

describe("agent edits from the board", () => {
    it("delivers a rename as content without changing activity, and keeps the same value a no-op", () => {
        const target = join("Original");
        const viewer = join("Viewer");
        checkIn(target.agent_id, { status: "working", editing: ["src/work.ts"], role: "API owner" });
        checkIn(viewer.agent_id);
        const before = card(target.agent_id);

        expect(store.setNameFromBoard(target.agent_id, "  Renamed  ")).toBe(true);
        const after = card(target.agent_id);
        expect(after).toEqual({
            ...before,
            display_name: "Renamed",
            revision: Number(before.revision) + 1,
            changed_seq: after.changed_seq,
            content_changed_seq: after.changed_seq,
            updated_at: expect.any(String),
        });
        expect(Number(after.changed_seq)).toBeGreaterThan(Number(before.changed_seq));
        expect(checkIn(viewer.agent_id).agents).toEqual([expect.objectContaining({ agent_id: target.agent_id, name: "Renamed", role: "API owner" })]);
        expect(store.setNameFromBoard(target.agent_id, "Renamed")).toBe(true);
        expect(card(target.agent_id)).toEqual(after);
    });

    it("marks role changes and clearing as content while keeping activity and no-op revisions", () => {
        const target = join("Target");
        const viewer = join("Viewer");
        checkIn(target.agent_id, { status: "working", editing: ["src/work.ts"] });
        checkIn(viewer.agent_id);
        const before = card(target.agent_id);
        store.setRoleFromBoard(target.agent_id, "  Test deployments  ");
        const after = card(target.agent_id);
        expect(after).toEqual({
            ...before,
            role: "Test deployments",
            revision: Number(before.revision) + 1,
            changed_seq: after.changed_seq,
            content_changed_seq: after.changed_seq,
            updated_at: expect.any(String),
        });
        expect(Number(after.changed_seq)).toBeGreaterThan(Number(before.changed_seq));
        expect(checkIn(viewer.agent_id).agents).toEqual([expect.objectContaining({ agent_id: target.agent_id, role: "Test deployments" })]);
        store.setRoleFromBoard(target.agent_id, "Test deployments");
        expect(card(target.agent_id)).toEqual(after);
        store.setRoleFromBoard(target.agent_id, "");
        const cleared = card(target.agent_id);
        expect(cleared.role).toBe("");
        expect(cleared.content_changed_seq).toBe(cleared.changed_seq);
        expect(Number(cleared.changed_seq)).toBeGreaterThan(Number(after.changed_seq));
        expect(cleared.last_call_at).toBe(before.last_call_at);
    });

    it("rejects live name collisions across projects and human names, without changing the card", () => {
        const target = join("Target");
        join("Taken", "other-project");
        store.ensureHumanParticipant("main", "Reviewer");
        const before = card(target.agent_id);
        expect(store.setNameFromBoard(target.agent_id, "Taken")).toBe(false);
        expect(store.setNameFromBoard(target.agent_id, " Reviewer ")).toBe(false);
        expect(card(target.agent_id)).toEqual(before);
    });

    it("allows names belonging only to disconnected, left or expired cards", () => {
        const target = join("Target");
        const disconnected = join("Disconnected");
        const left = join("Left");
        const expired = join("Expired");
        store.disconnect([disconnected.agent_id]);
        store.leave(left.agent_id, { summary: null, nextStep: null, checkpoint: null });
        database.prepare("UPDATE agent SET last_seen_at = :at WHERE id = :id").run({ at: "2000-01-01T00:00:00.000Z", id: expired.agent_id });
        for(const name of ["Disconnected", "Left", "Expired"]) {
            expect(store.setNameFromBoard(target.agent_id, name)).toBe(true);
            expect(card(target.agent_id).display_name).toBe(name);
        }
    });

    it("enforces nonempty and maximum names and refuses to edit human cards", () => {
        const target = join("Target");
        const before = card(target.agent_id);
        for(const name of ["", "   ", "x".repeat(MAX_DISPLAY_NAME_LENGTH + 1)]) {
            expect(() => store.setNameFromBoard(target.agent_id, name)).toThrow(/display name must contain/);
            expect(card(target.agent_id)).toEqual(before);
        }
        expect(store.setNameFromBoard(target.agent_id, "x".repeat(MAX_DISPLAY_NAME_LENGTH))).toBe(true);
        expect(() => store.setRoleFromBoard(target.agent_id, "x".repeat(MAX_ROLE_LENGTH + 1))).toThrow(/role must contain/);
        const human = store.ensureHumanParticipant("main", "Reviewer");
        expect(() => store.setNameFromBoard(human, "Renamed")).toThrow(/person's name/);
        expect(() => store.setRoleFromBoard(human, "Owner")).toThrow(/no role card/);
    });

    it("lets a later check_in or resumed join replace the name set at the board", () => {
        const target = join("Session name");
        store.setNameFromBoard(target.agent_id, "Board name");
        checkIn(target.agent_id, { displayName: "Reported name" });
        expect(card(target.agent_id).display_name).toBe("Reported name");
        store.setNameFromBoard(target.agent_id, "Board name");
        const resumed = store.join({ displayName: "Session name", client: "test", workingDirectory: path.join(directory, "project"), workspaceRoot: null, resumeHandle: target.handle });
        expect(resumed.agent_id).toBe(target.agent_id);
        expect(card(target.agent_id).display_name).toBe("Session name");
    });
});
