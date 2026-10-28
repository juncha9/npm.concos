import { describe, expect, it } from "vitest";
import { RoomActivity } from "../src/modules/cli/room-activity";
import type { RoomOverviewAgent, RoomOverviewMessage } from "../src/modules/store/room-store";
import type { Style } from "../src/modules/cli/prompter";

const style: Style = { accent: (text) => text, success: (text) => text, warning: (text) => text, danger: (text) => text, dim: (text) => text, bold: (text) => text, inverse: (text) => text };
const agent: RoomOverviewAgent = {
    agent_id: "one", name: "Server", client: "Codex", human: false, status: "waiting", role: "",
    task: "storage", next_step: "review", blocker: "", blocker_since: null, editing: [], recent_folders: [], workspace_path: "/project", working_directory: "/project", current_directory: null,
    updated_at: "2026-10-25T00:00:00Z", online: true, stale: false, left: false, ended: false, pending_count: 0,
    concos_version: null, context: null, issues: [],
};
const message: RoomOverviewMessage = {
    id: 1, at: agent.updated_at, from_name: "Server", from_client: "Codex", from_human: false,
    to_name: null, recipients: [], to_agent_id: null, to_human: false, topics: [], posted: false, edited_at: null, resolved: false,
    waiting_on: ["Reviewer"], waiting_on_participants: [{ name: "Reviewer", client: "Claude Code", human: false }],
    kind: "question", reply_to: null, text: "Please review",
};
const tabs = { active: "tab:agents", items: [{ value: "tab:agents", label: "Agents 1" }, { value: "tab:messages", label: "Messages 1" }] };
const badge = (activity: RoomActivity, key: string) => activity.badge(key, style).map((part) => part.text).join("");

describe("waiting room activity", () => {
    it("starts quietly, reacts to changed content once, and lets the highlight expire across unchanged polls", () => {
        const activity = new RoomActivity(true, true, false, true);
        activity.update([agent], [], "tab:agents", 0);
        expect(badge(activity, "agent:one")).toBe("");
        expect(activity.heading("Waiting room")).toBe("Waiting room");
        const changed = { ...agent, task: "new task" };
        activity.update([changed], [], "tab:agents", 100);
        expect(badge(activity, "agent:one")).toContain("UPDATED");
        const first = activity.indicator("agent:one");
        activity.tick(240);
        expect(activity.indicator("agent:one")).not.toBe(first);
        activity.update([changed], [], "tab:agents", 1000);
        activity.tick(3300);
        expect(badge(activity, "agent:one")).toBe("");
    });

    it("keeps offscreen arrivals on the tab and replays their pulse when visited without changing receipts", () => {
        const activity = new RoomActivity(true, true, true, true);
        activity.update([agent], [], "tab:agents", 0);
        activity.update([agent], [message], "tab:agents", 100);
        expect(activity.tabs(tabs).items[1]).toMatchObject({ attention: true });
        expect(activity.tabs(tabs).items[1].label).toContain("+1");
        activity.tick(5000);
        expect(badge(activity, "message:1")).toBe("");
        expect(activity.tabs(tabs).items[1].label).toContain("+1");
        activity.update([agent], [message], "tab:messages", 5000);
        expect(badge(activity, "message:1")).toContain("NEW");
        expect(activity.tabs(tabs).items[1].label).not.toContain("+1");
        expect(message).toMatchObject({ resolved: false, waiting_on: ["Reviewer"] });
    });

    it("treats a message that arrives already received as new, since the board lists it too", () => {
        const activity = new RoomActivity(true, true, true, true);
        activity.update([agent], [], "tab:agents", 0);
        const received = { ...message, resolved: true, waiting_on: [], waiting_on_participants: [] };
        activity.update([agent], [received], "tab:agents", 100);
        expect(activity.tabs(tabs).items[1].label).toContain("+1");
        activity.update([agent], [received], "tab:messages", 5000);
        expect(badge(activity, "message:1")).toContain("NEW");
    });

    it("distinguishes status, inbox and receipt changes and does not leave a counter for resolved messages", () => {
        const activity = new RoomActivity(true, true, false, true);
        activity.update([agent], [message], "tab:agents", 0);
        const working = { ...agent, status: "working" as const };
        activity.update([working], [message], "tab:agents", 100);
        expect(badge(activity, "agent:one")).toContain("STATE");
        activity.update([{ ...working, pending_count: 1 }], [message], "tab:agents", 200);
        expect(badge(activity, "agent:one")).toContain("INBOX");
        const resolved = { ...message, resolved: true, waiting_on: [], waiting_on_participants: [] };
        activity.update([{ ...working, pending_count: 1 }], [resolved], "tab:agents", 300);
        expect(badge(activity, "message:1")).toContain("SEEN");
        expect(activity.tabs(tabs).items[1].label).not.toContain("+1");
    });

    it("keeps reduced motion static and leaves piped output undecorated", () => {
        const reduced = new RoomActivity(true, false, false, true);
        reduced.update([agent], [], "tab:agents", 0);
        reduced.update([agent], [message], "tab:agents", 100);
        const first = reduced.indicator("message:1");
        reduced.tick(500);
        expect(reduced.indicator("message:1")).toBe(first);
        const plain = new RoomActivity(false, false, false, true);
        plain.update([agent], [], "tab:agents", 0);
        plain.update([agent], [message], "tab:agents", 100);
        expect(plain.heading("Waiting room")).toBe("Waiting room");
        expect(plain.tabs(tabs)).toEqual(tabs);
        expect(badge(plain, "message:1")).toBe("");
    });

    it.each([false, true])("pulses only the newest folder path, not repeated timestamps or card rows (motion=%s)", (motion) => {
        const colors: Style = { ...style, accent: (text) => `accent(${text})`, dim: (text) => `dim(${text})`, bold: (text) => `bold(${text})` };
        const activity = new RoomActivity(true, motion, false, true);
        const initial = { ...agent, recent_folders: [{ path: "src/cli", at: agent.updated_at }] };
        activity.update([initial], [], "tab:agents", 0);
        expect(activity.folderPaint(agent.agent_id, colors, colors.dim)?.("path")).toBe("dim(path)");
        const changed = { ...initial, editing: ["src/store/db.ts"], updated_at: "2026-10-25T00:01:00Z", recent_folders: [{ path: "src/store", at: "2026-10-25T00:01:00Z" }, ...initial.recent_folders] };
        activity.update([changed], [], "tab:agents", 100);
        expect(activity.folderPaint(agent.agent_id, colors, colors.dim)?.("path")).toBe("bold(accent(path))");
        expect(badge(activity, "agent:one")).toBe("");
        expect(activity.heading("Waiting room")).toBe("Waiting room");
        const repeated = { ...changed, recent_folders: [{ path: "src/store", at: "2026-10-25T00:02:00Z" }, ...initial.recent_folders] };
        activity.update([repeated], [], "tab:agents", 2000);
        activity.tick(2400);
        expect(activity.folderPaint(agent.agent_id, colors, colors.dim)?.("path")).toBe(motion ? "dim(path)" : "bold(accent(path))");
        activity.tick(3300);
        expect(activity.folderPaint(agent.agent_id, colors, colors.dim)?.("path")).toBe("dim(path)");
        expect(badge(activity, "agent:one")).toBe("");
        activity.update([{ ...repeated, task: "Changed task", recent_folders: [{ path: "docs", at: "2026-10-25T00:03:00Z" }] }], [], "tab:agents", 3400);
        expect(badge(activity, "agent:one")).toContain("UPDATED");
        expect(activity.folderPaint(agent.agent_id, colors)?.("path")).toBe("bold(accent(path))");
    });
});
