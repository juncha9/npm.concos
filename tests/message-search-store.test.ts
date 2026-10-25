import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/modules/store/database";
import { RoomError } from "../src/modules/store/room-error";
import { RoomStore } from "../src/modules/store/room-store";

let directory: string;
let database: DatabaseSync;
let store: RoomStore;
let viewer: string;
let alice: string;
let bob: string;

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-message-search-store-"));
    database = await openDatabase(directory);
    store = new RoomStore(database);
    const join = (name: string) => store.join({
        displayName: name, client: "test", workingDirectory: directory,
        workspaceRoot: null, resumeHandle: null,
    }).agent_id;
    alice = join("Alice / API");
    bob = join("Bob / UI");
    viewer = store.ensureHumanParticipant("main", "Reviewer");
});

afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function send(from: string, to: string | string[], text: string, topics: string[] = []): number {
    return store.sendMessage(from, {
        to: to, text: text, topics: topics, kind: "note", replyTo: null, requestId: null,
    }).message_id;
}

describe("message search", () => {
    it("finds literal body text regardless of ASCII case, newest first", () => {
        const first = send(alice, viewer, "Deploy the API\nFull details remain available.");
        send(alice, viewer, "Other release");
        const latest = send(bob, viewer, "Ready to DEPLOY");
        const result = store.searchMessages({ text: " deploy " });
        expect(result.messages.map((message) => message.id)).toEqual([latest, first]);
        expect(result.messages[1].text).toContain("\nFull details remain available.");

        const literal = send(alice, viewer, "Progress is 100%_done");
        send(bob, viewer, "Progress is 100 percent done");
        expect(store.searchMessages({ text: "%_" }).messages.map((message) => message.id)).toEqual([literal]);
    });

    it("matches the topic and its narrower topics with readMessages normalization and word boundaries", () => {
        const exact = send(alice, viewer, "Login", ["webapp_login"]);
        const narrow = send(alice, viewer, "Redirect", ["webapp_login_redirect", "release_notes"]);
        send(alice, viewer, "Different word", ["webapp_logins"]);
        send(alice, viewer, "Different branch", ["webapp_logout"]);
        expect(store.searchMessages({ topic: "Webapp login" }).messages.map((message) => message.id)).toEqual([narrow, exact]);
        expect(store.searchMessages({ topic: "webapp_login" }).messages.map((message) => message.id))
            .toEqual(store.readMessages(viewer, { messageIds: null, limit: 10, topic: "webapp_login" }).messages.map((message) => message.id).reverse());
        expect(() => store.searchMessages({ topic: "webapp_%" })).toThrow(RoomError);
    });

    it("finds a sender by display-name substring and combines supplied filters", () => {
        const matching = send(alice, viewer, "Deploy ready", ["webapp_login"]);
        send(alice, viewer, "Other item", ["webapp_login"]);
        send(bob, viewer, "Deploy ready", ["webapp_login"]);
        send(alice, viewer, "Deploy ready", ["webapp_logout"]);
        expect(store.searchMessages({ sender: "aLiCe / aPi" }).messages).toHaveLength(3);
        expect(store.searchMessages({ text: "deploy", sender: "alice", topic: "webapp_login" }).messages.map((message) => message.id)).toEqual([matching]);
    });

    it("includes every retained direct message, group and post shown on the board", () => {
        const direct = send(alice, viewer, "Search direct");
        const group = send(alice, [viewer, bob], "Search group");
        const sent = send(viewer, bob, "Search sent");
        const post = send(bob, "all", "Search post");
        const betweenAgents = send(alice, bob, "Search between agents");
        const otherPerson = store.ensureHumanParticipant("main", "Another reviewer");
        const toAnotherPerson = send(alice, otherPerson, "Search for another person");
        const result = store.searchMessages({ text: "search" });
        expect(result.messages.map((message) => message.id)).toEqual([toAnotherPerson, betweenAgents, post, sent, group, direct]);
        const overview = store.getRoomOverview("main", 100).messages;
        for(const message of result.messages) {
            expect(message).toEqual(overview.find((entry) => entry.id == message.id));
        }
    });

    it("searches the board without expanding what an agent can read through readMessages", () => {
        const betweenAgents = send(alice, bob, "Shared needle");
        const post = send(bob, "all", "Shared needle");
        expect(store.searchMessages({ text: "needle" }).messages.map((message) => message.id)).toEqual([post, betweenAgents]);
        expect(store.readMessages(viewer, { messageIds: [betweenAgents, post], limit: 10 }).messages.map((message) => message.id)).toEqual([post]);
    });

    it("limits matches after filtering and reports whether more remain", () => {
        const first = send(alice, viewer, "Needle one");
        const second = send(alice, viewer, "Needle two");
        const third = send(alice, viewer, "Needle three");
        send(bob, viewer, "Does not match");
        expect(store.searchMessages({ text: "needle", limit: 2 })).toMatchObject({
            messages: [{ id: third }, { id: second }], has_more: true,
        });
        expect(store.searchMessages({ text: "needle", limit: 3 }).messages.map((message) => message.id)).toEqual([third, second, first]);
        expect(store.searchMessages({ text: "needle", limit: 3 }).has_more).toBeUndefined();
    });

    it("searches retained history beyond the board's recent 50 messages", () => {
        const old = send(alice, viewer, "Earlier target");
        for(let index = 0; index < 55; index += 1) {
            send(alice, viewer, `Newer unrelated message ${index}`);
        }
        expect(store.getRoomOverview("main", 50).messages.some((message) => message.id == old)).toBe(false);
        expect(store.searchMessages({ text: "earlier target" }).messages.map((message) => message.id)).toEqual([old]);
        expect(store.searchMessages({}).messages).toHaveLength(50);
        expect(store.searchMessages({}).has_more).toBe(true);
    });

    it("does not return removed posts", () => {
        const removed = send(alice, "all", "Obsolete needle", ["webapp_login"]);
        const kept = send(bob, "all", "Current needle", ["webapp_login"]);
        store.removePosts(alice, [removed]);
        expect(store.searchMessages({ text: "needle" }).messages.map((message) => message.id)).toEqual([kept]);
        expect(store.searchMessages({ topic: "webapp_login" }).messages.map((message) => message.id)).toEqual([kept]);
    });

    it("performs only reads, leaving delivery, receipt and participant state untouched", () => {
        const id = send(alice, viewer, "Unread needle", ["webapp_login"]);
        const before = database.prepare("SELECT total_changes() AS count").get();
        database.exec("PRAGMA query_only = ON");
        expect(store.searchMessages({ text: "needle" }).messages[0].id).toBe(id);
        expect(store.searchMessages({ topic: "webapp" }).messages[0].id).toBe(id);
        expect(store.searchMessages({ sender: "alice" }).messages[0].id).toBe(id);
        expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(before);
        expect(database.prepare("SELECT delivered_at, received_at FROM message_receipt WHERE message_id = ? AND agent_id = ?").get(id, viewer))
            .toEqual({ delivered_at: null, received_at: null });
    });

    it.each([0, -1, 1.5, 101, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid limit %s", (limit) => {
        expect(() => store.searchMessages({ limit: limit })).toThrow(/limit/);
    });
});
