import { describe, expect, it } from "vitest";
import { InstructionsUpdate } from "../src/modules/mcp/instructions-update";

const CURRENT = "Check in at meaningful task boundaries.\nDo not send receipt confirmations or progress restatements.\nUse wake: false when no wake is needed.";
const PREVIOUS = "Check in at task boundaries.\nSend a confirmation when you receive a request.";
const VERSION = "0.1.19";

describe("instructions carried across a server replacement", () => {
    it.each([null, "0.1.18", VERSION])("never announces instructions the client already has (fromVersion=%s)", (fromVersion) => {
        const update = new InstructionsUpdate({ current: CURRENT, version: VERSION, seen: CURRENT, fromVersion });
        expect(update.seen()).toBe(CURRENT);
        expect(update.take()).toBeNull();
        expect(update.take()).toBeNull();
        expect(update.seen()).toBe(CURRENT);
    });

    it("announces changed instructions once, naming the previous and current versions", () => {
        const update = new InstructionsUpdate({ current: CURRENT, version: VERSION, seen: PREVIOUS, fromVersion: "0.1.18" });
        expect(update.seen()).toBe(PREVIOUS);
        const text = update.take()!;
        const introduction = text.split("\n\n")[0];
        expect(introduction).toContain("from 0.1.18 to 0.1.19 during this session");
        expect(introduction).toContain("instructions changed");
        expect(introduction).toContain("follow the instructions below");
        expect(text.endsWith(`\n\n${CURRENT}`)).toBe(true);
        expect(text).not.toContain(PREVIOUS);
        expect(update.seen()).toBe(CURRENT);
        expect(update.take()).toBeNull();
        expect(update.take()).toBeNull();
    });

    it.each(["0.1.17", "0.1.18", null])("announces unknown inherited instructions once (fromVersion=%s)", (fromVersion) => {
        const update = new InstructionsUpdate({ current: CURRENT, version: VERSION, seen: null, fromVersion });
        expect(update.seen()).toBe("");
        // Inspecting the handoff value must leave the first announcement pending.
        expect(update.seen()).toBe("");
        const text = update.take()!;
        expect(text).toContain(`to ${VERSION} during this session`);
        if(fromVersion == null) expect(text.split("\n\n")[0]).not.toContain(" from ");
        else expect(text).toContain(`from ${fromVersion} to ${VERSION}`);
        expect(text).not.toContain("null");
        expect(text).not.toContain("undefined");
        expect(text.endsWith(`\n\n${CURRENT}`)).toBe(true);
        expect(update.seen()).toBe(CURRENT);
        expect(update.take()).toBeNull();
    });

    it("can announce a changed string even when the version number stays the same", () => {
        const update = new InstructionsUpdate({ current: CURRENT, version: VERSION, seen: PREVIOUS, fromVersion: VERSION });
        expect(update.take()).toContain(CURRENT);
        expect(update.take()).toBeNull();
    });

    it("preserves the complete current instructions, including spacing and line endings", () => {
        const current = "  First instruction.\r\n\r\nSecond instruction.\n  ";
        const update = new InstructionsUpdate({ current, version: VERSION, seen: current.trim(), fromVersion: null });
        expect(update.take()!.endsWith(`\n\n${current}`)).toBe(true);
        expect(update.seen()).toBe(current);
        expect(update.take()).toBeNull();
    });

    it("does not repeat an announcement when the next server inherits seen()", () => {
        const first = new InstructionsUpdate({ current: CURRENT, version: VERSION, seen: PREVIOUS, fromVersion: "0.1.18" });
        first.take();
        const next = new InstructionsUpdate({ current: CURRENT, version: "0.1.20", seen: first.seen(), fromVersion: VERSION });
        expect(next.take()).toBeNull();
        expect(next.seen()).toBe(CURRENT);
    });

    it("keeps an undelivered change pending when handed off before take()", () => {
        const first = new InstructionsUpdate({ current: CURRENT, version: VERSION, seen: PREVIOUS, fromVersion: "0.1.18" });
        const next = new InstructionsUpdate({ current: CURRENT, version: "0.1.20", seen: first.seen(), fromVersion: VERSION });
        expect(next.seen()).toBe(PREVIOUS);
        expect(next.take()).toContain("from 0.1.19 to 0.1.20");
        expect(next.seen()).toBe(CURRENT);
        expect(next.take()).toBeNull();
    });

    it("distinguishes an unknown value from known empty instructions", () => {
        const unknown = new InstructionsUpdate({ current: "", version: VERSION, seen: null, fromVersion: null });
        expect(unknown.seen()).toBe("");
        expect(unknown.take()).toBeTypeOf("string");
        expect(unknown.seen()).toBe("");
        expect(unknown.take()).toBeNull();
        const known = new InstructionsUpdate({ current: "", version: VERSION, seen: "", fromVersion: null });
        expect(known.take()).toBeNull();
    });
});
