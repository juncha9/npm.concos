import type { RoomOverviewAgent, RoomOverviewMessage } from "../store/room-store";
import type { LinePart, SelectTabs, Style } from "./prompter";

export type ActivityTab = "tab:agents" | "tab:messages";
type Change = "JOINED" | "UPDATED" | "STATE" | "INBOX" | "NEW" | "SEEN";
interface Pulse { kind: Change; at: number }
const PULSE_MS = 3200;
const FRAME_MS = 140;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ASCII_FRAMES = ["|", "/", "-", "\\"];

/** Visual activity only: observing or opening a tab never acknowledges a message in the store. */
export class RoomActivity {
    private now = 0;
    private initialized = false;
    private agents = new Map<string, RoomOverviewAgent>();
    private messages = new Map<number, RoomOverviewMessage>();
    private readonly pulses = new Map<string, Pulse>();
    private readonly folderPulses = new Map<string, number>();
    private readonly unseen: Record<ActivityTab, Set<string>> = { "tab:agents": new Set(), "tab:messages": new Set() };
    private readonly changedAt: Record<ActivityTab, number> = { "tab:agents": -Infinity, "tab:messages": -Infinity };
    private notice: { text: string; at: number } | null = null;

    constructor(readonly enabled: boolean, readonly motion: boolean, private readonly unicode: boolean, private readonly english: boolean) {}

    tick(now: number): void { this.now = now; }

    private mark(key: string, kind: Change, tab: ActivityTab, activeTab: ActivityTab, visible = true): void {
        this.pulses.set(key, { kind, at: this.now });
        this.changedAt[tab] = this.now;
        if(tab != activeTab && visible) this.unseen[tab].add(key);
    }

    update(agents: RoomOverviewAgent[], messages: RoomOverviewMessage[], tab: ActivityTab, now: number): void {
        this.tick(now);
        if(!this.enabled) return;
        // Visiting an inactive tab replays the highlights that arrived while it was away.
        for(const key of this.unseen[tab]) {
            const pulse = this.pulses.get(key);
            if(pulse != null) pulse.at = now;
        }
        this.unseen[tab].clear();
        let joined = 0;
        let updated = 0;
        let received = 0;
        let receipts = 0;
        if(this.initialized) {
            for(const agent of agents) {
                const previous = this.agents.get(agent.agent_id);
                const key = `agent:${agent.agent_id}`;
                const visible = !agent.left && !agent.ended;
                if(previous == null) {
                    if(visible) { this.mark(key, "JOINED", "tab:agents", tab); joined += 1; }
                }
                else {
                    const newest = agent.recent_folders[0]?.path;
                    if(newest != null && newest != previous.recent_folders[0]?.path) {
                        this.folderPulses.set(agent.agent_id, now);
                    }
                    // Folder/editing changes already show in the location; their timestamp is not a card update badge.
                    const currentCard = { ...agent, recent_folders: [], editing: [] };
                    const previousCard = { ...previous, recent_folders: [], editing: [] };
                    if(JSON.stringify(agent.recent_folders) != JSON.stringify(previous.recent_folders) || JSON.stringify(agent.editing) != JSON.stringify(previous.editing)) {
                        currentCard.updated_at = previousCard.updated_at;
                    }
                    if(JSON.stringify(currentCard) == JSON.stringify(previousCard)) {
                        continue;
                    }
                    let kind: Change = "UPDATED";
                    if(agent.status != previous.status || agent.online != previous.online || agent.ended != previous.ended || agent.left != previous.left || agent.blocker != previous.blocker) kind = "STATE";
                    else if(agent.pending_count > previous.pending_count) kind = "INBOX";
                    this.mark(key, kind, "tab:agents", tab, visible);
                    updated += 1;
                }
            }
            for(const message of messages) {
                const previous = this.messages.get(message.id);
                const key = `message:${message.id}`;
                if(previous == null) {
                    this.mark(key, "NEW", "tab:messages", tab);
                    received += 1;
                }
                else if(JSON.stringify(message) != JSON.stringify(previous)) {
                    const kind = message.waiting_on.length < previous.waiting_on.length ? "SEEN" : "UPDATED";
                    // the last receipt pulses the row but does not light the tab: nobody is left to act;
                    // a rewritten post is news to everyone
                    this.mark(key, kind, "tab:messages", tab, !message.resolved || message.edited_at != previous.edited_at);
                    receipts += 1;
                }
            }
            const parts: string[] = [];
            if(joined > 0) parts.push(this.english ? `${joined} agent${joined == 1 ? "" : "s"} joined` : `새 참가자 ${joined}명`);
            if(updated > 0) parts.push(this.english ? `${updated} agent update${updated == 1 ? "" : "s"}` : `에이전트 변경 ${updated}건`);
            if(received > 0) parts.push(this.english ? `${received} new message${received == 1 ? "" : "s"}` : `새 메시지 ${received}개`);
            if(receipts > 0) parts.push(this.english ? `${receipts} message update${receipts == 1 ? "" : "s"}` : `메시지 변경 ${receipts}건`);
            if(parts.length > 0) this.notice = { text: parts.join(" · "), at: now };
        }
        this.initialized = true;
        this.agents = new Map(agents.map((agent) => [agent.agent_id, agent]));
        this.messages = new Map(messages.map((message) => [message.id, message]));
        const visible = new Set([
            ...agents.filter((agent) => !agent.left && !agent.ended).map((agent) => `agent:${agent.agent_id}`),
            ...messages.map((message) => `message:${message.id}`),
        ]);
        for(const unseen of Object.values(this.unseen)) for(const key of unseen) if(!visible.has(key)) unseen.delete(key);
        for(const [key, pulse] of this.pulses) {
            if(now - pulse.at >= PULSE_MS && !this.unseen["tab:agents"].has(key) && !this.unseen["tab:messages"].has(key)) this.pulses.delete(key);
        }
        for(const [id, at] of this.folderPulses) {
            if(now - at >= PULSE_MS || !this.agents.has(id)) {
                this.folderPulses.delete(id);
            }
        }
    }

    private recent(key: string): Pulse | undefined {
        const pulse = this.pulses.get(key);
        return pulse != null && this.now - pulse.at < PULSE_MS ? pulse : undefined;
    }

    private frame(): string {
        if(!this.motion) return this.unicode ? "●" : "*";
        const frames = this.unicode ? FRAMES : ASCII_FRAMES;
        return frames[Math.floor(this.now / FRAME_MS) % frames.length];
    }

    indicator(key: string, working = false): string {
        if(!this.enabled) return "";
        if(this.recent(key) != null || (working && this.motion)) return `${this.frame()} `;
        return "  ";
    }

    badge(key: string, style: Style): LinePart[] {
        const pulse = this.recent(key);
        if(pulse == null) return [];
        let paint = style.accent;
        if(pulse.kind == "NEW" || pulse.kind == "JOINED" || pulse.kind == "SEEN") paint = style.success;
        else if(pulse.kind == "STATE" || pulse.kind == "INBOX") paint = style.warning;
        const elapsed = this.now - pulse.at;
        if(elapsed > PULSE_MS * 0.7) paint = style.dim;
        else if(!this.motion || Math.floor(elapsed / FRAME_MS) % 4 < 2) {
            const color = paint;
            paint = (text) => style.bold(color(text));
        }
        return [{ text: `  ${pulse.kind}`, paint }];
    }

    folderPaint(agentId: string, style: Style, baseline?: (text: string) => string): ((text: string) => string) | undefined {
        const at = this.folderPulses.get(agentId);
        if(at == null || this.now - at >= PULSE_MS) {
            return baseline;
        }
        const elapsed = this.now - at;
        if(!this.motion) {
            return (text) => style.bold(style.accent(text));
        }
        if(elapsed > PULSE_MS * 0.7) {
            return style.dim;
        }
        if(Math.floor(elapsed / FRAME_MS) % 4 < 2) {
            return (text) => style.bold(style.accent(text));
        }
        return baseline;
    }

    heading(base: string): string {
        if(!this.enabled) return base;
        if(this.notice == null || this.now - this.notice.at >= PULSE_MS) {
            const working = [...this.agents.values()].some((agent) => !agent.left && !agent.ended && !agent.human && agent.status == "working" && agent.blocker == "");
            return this.motion && working ? `${this.frame()} ${base}` : base;
        }
        const [title, ...counts] = base.split(" · ");
        return [title, `${this.frame()} ${this.notice.text}`, ...counts].join(" · ");
    }

    tabs<T extends string>(tabs: SelectTabs<T>): SelectTabs<T> {
        if(!this.enabled) return tabs;
        return { ...tabs, items: tabs.items.map((tab) => {
            if(tab.value != "tab:agents" && tab.value != "tab:messages") return tab;
            const value = tab.value as ActivityTab;
            const pending = this.unseen[value].size;
            const fresh = this.now - this.changedAt[value] < PULSE_MS;
            if(pending == 0 && !fresh) return tab;
            const marker = fresh ? this.frame() : (this.unicode ? "●" : "*");
            return { ...tab, label: `${tab.label}${pending > 0 ? ` +${pending}` : ""} ${marker}`, attention: pending > 0 || fresh };
        }) };
    }
}
