import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showMessageSearch } from "../src/modules/cli/message-search";
import type { MessageSearchOptions } from "../src/modules/cli/message-search";
import { Prompter, PromptClosedError } from "../src/modules/cli/prompter";
import { openDatabase } from "../src/modules/store/database";
import { RoomStore } from "../src/modules/store/room-store";
import { TerminalScreen } from "./terminal-screen";

let directory: string;
let database: DatabaseSync;
let store: RoomStore;
let viewer: string;
let alice: string;
let bob: string;

beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "concos-message-search-ui-"));
    database = await openDatabase(directory);
    store = new RoomStore(database);
    const join = (name: string) => store.join({
        displayName: name, client: "Codex", workingDirectory: directory,
        workspaceRoot: null, resumeHandle: null,
    }).agent_id;
    alice = join("Alice / API");
    bob = join("Bob / UI");
    viewer = store.ensureHumanParticipant("main", "Reviewer");
});

afterEach(() => {
    vi.unstubAllEnvs();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});

function send(to = viewer, text = "Needle first line\nFull detail on the second line.", topics = ["webapp_login_redirect"]): number {
    return store.sendMessage(alice, {
        to: to, text: text, topics: topics, kind: "question", replyTo: null, requestId: null,
    }).message_id;
}

async function search(answers: string, options: Partial<MessageSearchOptions> = {}): Promise<string> {
    const input = Readable.from([answers]);
    const output = new PassThrough();
    let written = "";
    output.on("data", (chunk) => { written += chunk.toString(); });
    const prompter = new Prompter(input, output);
    try {
        await showMessageSearch(prompter, store, { language: "en", columns: 80, ...options });
        expect(prompter.transient).toBe(false);
        return written;
    }
    finally {
        prompter.close();
        expect(input.listenerCount("data")).toBe(0);
        expect(input.listenerCount("end")).toBe(0);
    }
}

describe("message search screen", () => {
    it("goes straight to the results of text typed on the board, and back to the board from them", async () => {
        send();
        const output = await search("ESC\n", { text: "  needle " });
        expect(output).toContain("? Message search · needle · 1 result");
        expect(output).not.toContain("? Search messages by");
    });

    it("goes from query to results to full detail and returns one level at a time with Esc in line mode", async () => {
        const id = send();
        send(bob, "Unrelated agent traffic");
        database.exec("PRAGMA query_only = ON");
        const output = await search("text\nneedle\n1\nESC\nESC\nESC\nESC\n");

        // grouped by sender: the group names Alice, the row only whom it went to
        expect(output).toMatch(/Alice \/ API \(Codex\) +1 message\n/);
        expect(output).toContain(`#${id} → Reviewer`);
        expect(output).toContain("Topics webapp_login_redirect");
        expect(output).toContain("Needle first line");
        expect(output).toContain(`#${id} [QUESTION]`);
        expect(output).toContain("Full detail on the second line.");
        expect(output).not.toContain("Unrelated agent traffic");
        expect(output.match(/\? Message search · needle · 1 result/g)).toHaveLength(2);
        expect(output).toContain("? Message text (needle)");
        expect(output.match(/\? Search messages by/g)).toHaveLength(2);
        expect(database.prepare("SELECT delivered_at, received_at FROM message_receipt WHERE message_id = ? AND agent_id = ?").get(id, viewer))
            .toEqual({ delivered_at: null, received_at: null });
    });

    it("groups results by sender, the sender of the newest match first and each group newest first", async () => {
        const older = send(viewer, "Needle one");
        const fromBob = store.sendMessage(bob, { to: viewer, text: "Needle from Bob", topics: [], kind: "note", replyTo: null, requestId: null }).message_id;
        const newest = send(viewer, "Needle three");
        const output = await search("text\nneedle\nESC\nESC\nESC\n");
        const alice = output.search(/Alice \/ API \(Codex\) +2 messages\n/);
        const bobGroup = output.search(/Bob \/ UI \(Codex\) +1 message\n/);
        expect(alice).toBeGreaterThan(-1);
        expect(bobGroup).toBeGreaterThan(alice);
        expect(output.indexOf(`#${newest} → Reviewer`)).toBeGreaterThan(alice);
        expect(output.indexOf(`#${older} → Reviewer`)).toBeGreaterThan(output.indexOf(`#${newest} → Reviewer`));
        expect(output.indexOf(`#${fromBob} → Reviewer`)).toBeGreaterThan(bobGroup);
    });

    it("reports no matches and allows a new query from that screen", async () => {
        send();
        const output = await search("text\nmissing\nESC\nneedle\nESC\nESC\nESC\n");
        expect(output).toContain("No messages found");
        expect(output).toContain("Search again");
        expect(output.indexOf("No messages found")).toBeLessThan(output.indexOf("Message search · needle · 1 result"));
    });

    it("shows messages addressed to agents, matching the board's scope", async () => {
        const id = send(bob, "Needle between agents\nAgent detail.");
        const output = await search("text\nneedle\n1\nESC\nESC\nESC\nESC\n");
        expect(output).toContain(`#${id} → Bob / UI (Codex)`);
        expect(output).toContain("Agent detail.");
    });

    it("selects topic and sender searches and keeps each query when returning", async () => {
        const id = send();
        const output = await search(`topic\nWebapp login\nmessage:${id}\nback\nback\nESC\nsender\nalice\n1\nESC\nESC\nESC\nESC\n`);
        expect(output).toContain("Message search · Webapp login · 1 result");
        expect(output).toContain("? Topic key (Webapp login)");
        expect(output).toContain("Message search · alice · 1 result");
        expect(output.match(new RegExp(`#${id} \\[QUESTION\\]`, "g"))).toHaveLength(2);
    });

    it("shows an invalid topic and returns to the topic prompt for correction", async () => {
        send();
        const output = await search("topic\nwebapp_%\nESC\nwebapp_login\nESC\nESC\nESC\n");
        expect(output).toContain("topic must be lowercase English words joined by underscores");
        expect(output).toContain("Try again");
        expect(output).toContain("Message search · webapp_login · 1 result");
    });

    it("reports a result limit and lets the query be narrowed", async () => {
        send();
        const latest = send(viewer, "Needle newer\nDetails.");
        const output = await search("text\nneedle\nESC\nESC\nESC\n", { limit: 1 });
        expect(output).toContain("Newest 1 result · narrow your search for more");
        expect(output).toContain(`#${latest} → Reviewer`);
    });

    it("requires a nonempty query and supports the Korean and ASCII display options", async () => {
        const id = send();
        const output = await search("text\n\nneedle\nESC\nESC\nESC\n", { language: "ko", unicode: false });
        expect(output).toContain("A value is required.");
        expect(output).toContain("메시지 검색 기준");
        expect(output).toContain("결과 1개");
        expect(output).toContain(`#${id} -> Reviewer`);
        expect(output).toMatch(/Alice \/ API \(Codex\) +메시지 1개\n/);
        expect(output).toContain("주제 webapp_login_redirect");
    });

    it("restores transient mode when input closes inside the flow", async () => {
        const prompter = new Prompter(Readable.from(["text\n"]), new PassThrough());
        prompter.transient = true;
        try {
            await expect(showMessageSearch(prompter, store, { language: "en" })).rejects.toBeInstanceOf(PromptClosedError);
            expect(prompter.transient).toBe(true);
        }
        finally {
            prompter.close();
        }
    });

    it("returns through detail, results and query to the field selector with real terminal keys", async () => {
        send();
        vi.stubEnv("NO_COLOR", "1");
        const setRawMode = vi.fn();
        const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: setRawMode });
        const output = Object.assign(new PassThrough(), { isTTY: true, columns: 54, rows: 30 });
        const screen = new TerminalScreen(54, 30);
        screen.write("C:\\work>concos\n");
        let written = "";
        output.on("data", (chunk) => {
            written += chunk.toString();
            screen.write(chunk.toString());
        });
        const prompter = new Prompter(input, output);
        const running = showMessageSearch(prompter, store, { language: "en", columns: 54 });
        const visible = () => screen.visible().join("\n");
        try {
            await vi.waitFor(() => expect(visible()).toContain("Search messages by"));
            input.write("\r");
            await vi.waitFor(() => expect(visible()).toContain("? Message text"));
            for(const key of "needle") {
                input.write(key);
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            input.write("\r");
            await vi.waitFor(() => expect(visible()).toContain("Message search · needle · 1 result"));
            input.write("\r");
            await vi.waitFor(() => expect(visible()).toContain("Full detail on the second line."));
            input.write("\u001b");
            await vi.waitFor(() => {
                expect(visible()).toContain("Message search · needle · 1 result");
                expect(visible()).not.toContain("Full detail on the second line.");
            });
            input.write("\u001b");
            await vi.waitFor(() => expect(visible()).toContain("? Message text (needle)"));
            for(const key of "discarded") {
                input.write(key);
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
            input.write("\u001b");
            await vi.waitFor(() => expect(visible()).toContain("Search messages by"));
            input.write("\r");
            await vi.waitFor(() => {
                expect(visible()).toContain("? Message text (needle)");
                expect(visible()).not.toContain("discarded");
            });
            input.write("\u001b");
            await vi.waitFor(() => expect(visible()).toContain("Search messages by"));
            input.write("\u001b");
            await running;
            expect(screen.transcript().join("\n").trim()).toBe("C:\\work>concos");
            expect(setRawMode).toHaveBeenLastCalledWith(false);
            expect(written).toContain("\u001b[?25h");
        }
        finally {
            prompter.close();
        }
    });
});
