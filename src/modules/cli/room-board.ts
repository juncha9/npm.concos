import os from "node:os";
import path from "node:path";
import { MAX_DISPLAY_NAME_LENGTH, MAX_ROLE_LENGTH, SHARED_ROOM } from "../../_defs";
import { CONCOS_VERSION } from "../../_libs/version";
import { resolveDataDirectory } from "../../_libs/paths";
import { openDatabase } from "../store/database";
import { RoomStore } from "../store/room-store";
import type { RoomOverviewAgent, RoomOverviewMessage } from "../store/room-store";
import { displayWidth, padToWidth, PromptBackError } from "./prompter";
import type { LinePart, Prompter, SelectChoice, SelectItem, SelectOptions, SelectTabs, Style } from "./prompter";
import { age, issueText, plain, renderAgentDetailHeader, renderAgentDetailBody, recentFolderLines, renderMessageDetail, pendingMessageLines, stateLabel, stateOf, agentLocation, shortenPath, wrap, wrapMessageText, participantName, messageRecipientNames, previewText } from "./status-renderer";
import type { State, StatusRenderOptions } from "./status-renderer";
import { showMessageSearch } from "./message-search";
import { RoomActivity } from "./room-activity";
import type { ActivityTab } from "./room-activity";

const BOARD_REFRESH_MS = 1000;
const ANIMATION_FRAME_MS = 140;
/** Recent messages read for the Messages tab; open and resolved ones are shown in one list. */
const BOARD_MESSAGE_LIMIT = 50;
/** Pending names shown on a message row before the rest become a count. */
const PENDING_NAMES_SHOWN = 2;
const DETAIL_CHECKPOINT_LIMIT = 3;
const MESSAGE_BODY_INDENT = 2;
const MESSAGE_PREVIEW_LINES = 2;
/** Characters a sender's lead, `[Name → Recipient]` or `Name → Recipient:`, may run past the name. */
const SENDER_LEAD_SPAN = 60;
/** The question "Ask senders to tidy notices" sends each live poster, followed by its posts. */
const TIDY_REQUEST = "Please tidy your posts to all: remove the ones that no longer apply with remove_posts, and rewrite the ones that changed with send_message edit. Reply briefly once done. Your posts:";
/** Width of the first line each post shows in that question. */
const TIDY_PREVIEW_WIDTH = 80;
const STATE_PRIORITY: State[] = ["blocked", "working", "waiting", "idle", "finished", "offline", "left", "human"];
/** States whose rows recede: nothing is expected of them right now. */
const RECEDING_STATES: State[] = ["idle", "finished", "offline", "left"];
const PEOPLE_GROUP = "\u0000people";

export interface RoomBoardOptions extends StatusRenderOptions {
    /** Opens the send form for this agent, optionally as an answer to a message. */
    send: (agentId: string, reply?: { messageId: number; topics: string[] }) => Promise<void>;
}

type BoardTab = ActivityTab;

/** Object rows carry a prefix so an agent id or a message id can never collide with an action value. */
type BoardValue = `agent:${string}` | `message:${number}` | BoardTab | "toggle:ended" | "toggle:compact" | "tidy:posts" | "search:messages" | "retire:flagged" | "back";

type Poster = ReturnType<RoomStore["livePosters"]>[number];

/** Left or ended: still on record, folded away on the board. */
function isInactive(agent: RoomOverviewAgent): boolean {
    return agent.left == true || agent.ended == true;
}

/** An unwoken message calls for typing in the session, rather than taking its card down. */
function canTakeDownFlagged(agent: RoomOverviewAgent): boolean {
    return agent.human == false && isInactive(agent) == false && agent.issues.some((issue) => issue.kind != "unread_unwoken");
}

interface BoardView {
    question: string;
    /** Status shares, recent activity, and any issues under the question. */
    banner: LinePart[][];
    items: SelectItem<BoardValue>[];
    /** The first object row below the tab's actions. */
    defaultValue?: BoardValue;
    tabs: SelectTabs<BoardValue>;
    agents: RoomOverviewAgent[];
    messages: RoomOverviewMessage[];
    /** Live agents with posts, whom "Ask senders to tidy notices" asks; read for the Messages tab only. */
    posters: Poster[];
}

function oneLine(text: string): string {
    return plain(text).replace(/\s+/g, " ").trim();
}

/** Fill a compact cell without wrapping a short name down to its first word. */
function compactText(text: string, width: number, unicode: boolean): string {
    if(displayWidth(text) <= width) return text;
    const ellipsis = unicode ? "…" : ".".repeat(Math.min(3, width));
    let shown = "";
    for(const character of text) {
        if(displayWidth(shown + character + ellipsis) > width) break;
        shown += character;
    }
    return shown.trimEnd() + ellipsis;
}

function projectName(workspacePath: string, english: boolean): string {
    const name = workspacePath.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1);
    if(name == null || name == "") {
        return english ? "No workspace" : "위치 없음";
    }
    return name;
}

function statePaint(style: Style, state: State): (text: string) => string {
    if(state == "blocked") {
        return style.danger;
    }
    if(state == "working") {
        return style.success;
    }
    if(state == "waiting") {
        return style.warning;
    }
    if(state == "human") {
        return style.accent;
    }
    return style.dim;
}

/** Cells of the board's status bar. */
const STATUS_BAR_WIDTH = 16;

/** Each state's mark in the status bar, Unicode then ASCII, so the bar reads without color too. */
function barMark(state: State, unicode: boolean): string {
    const marks: Partial<Record<State, [string, string]>> = { blocked: ["▓", "!"], working: ["█", "#"], waiting: ["▒", "="] };
    const [wide, ascii] = marks[state] ?? ["░", "."];
    return unicode ? wide : ascii;
}

/** The agents around now, as a bar split by state and the count of each state. */
function statusBanner(agents: RoomOverviewAgent[], style: Style, english: boolean, unicode: boolean): LinePart[] {
    const shown = STATE_PRIORITY.filter((state) => state != "human")
        .map((state) => ({ state: state, count: agents.filter((agent) => stateOf(agent) == state).length }))
        .filter((entry) => entry.count > 0);
    const total = shown.reduce((sum, entry) => sum + entry.count, 0);
    const parts: LinePart[] = [];
    let used = 0;
    shown.forEach((entry, index) => {
        // every state shown keeps a cell; the last one takes what rounding left
        let cells = Math.max(1, Math.round(entry.count / total * STATUS_BAR_WIDTH));
        if(index == shown.length - 1) {
            cells = Math.max(1, STATUS_BAR_WIDTH - used);
        }
        used += cells;
        parts.push({ text: barMark(entry.state, unicode).repeat(cells), paint: statePaint(style, entry.state) });
    });
    shown.forEach((entry, index) => {
        parts.push({ text: index == 0 ? "  " : " · ", paint: style.dim });
        parts.push({ text: `${entry.count} ${stateLabel(entry.state, english).toLowerCase()}`, paint: statePaint(style, entry.state) });
    });
    return parts;
}

/** Lines a block written with `prompter.write("\n" + text + "\n\n")` occupies on screen. */
function writtenLineCount(text: string): number {
    return text.split("\n").length + 2;
}

/**
 * The Agents tab, grouped by project in a fixed order, by project and then agent name. Each agent is a
 * state column, its name and unread count followed by recent edit locations. Role, blocker,
 * task and next step sit on lines aligned under the name.
 */
function buildAgentItems(allAgents: RoomOverviewAgent[], style: Style, english: boolean, nowMs: number, showEnded: boolean, activity: RoomActivity, unicode = true, compact = false): {
    items: SelectItem<BoardValue>[];
    inactiveCount: number;
} {
    const agents = allAgents.filter((agent) => isInactive(agent) == false);
    const inactive = allAgents.filter((agent) => isInactive(agent) == true);
    // fixed widths from every possible value, so a refresh never shifts the columns
    const stateWidth = Math.max(...STATE_PRIORITY.map((state) => displayWidth(stateLabel(state, english).toLowerCase()))) + 2 + (activity.enabled ? 2 : 0);
    const fieldLabels = { check: english ? "Check" : "확인", role: english ? "Role" : "역할", blocker: english ? "Blocker" : "막힘", task: english ? "Task" : "작업", next: english ? "Next" : "다음" };
    const fieldWidth = Math.max(...Object.values(fieldLabels).map(displayWidth)) + 2;

    const unreadText = (agent: RoomOverviewAgent): string => {
        if(agent.pending_count == 0) {
            return "";
        }
        return english ? ` (${agent.pending_count} unread)` : ` (미확인 ${agent.pending_count})`;
    };
    const nameWidthOf = (agent: RoomOverviewAgent): number => displayWidth(participantName(agent.name, agent.client, agent.human) + unreadText(agent));
    const agentRow = (agent: RoomOverviewAgent, groupNameWidth: number): SelectItem<BoardValue> => {
        const state = stateOf(agent);
        const receding = RECEDING_STATES.includes(state);
        // label, text, tone, lines shown: the role stays put, so one line is enough
        const fields: [string, string, "plain" | "danger" | "warning", number][] = [
            // what looks wrong comes first, in yellow, so the person at the board can take the card down
            ...agent.issues.map((issue): [string, string, "warning", number] => [fieldLabels.check, issueText(issue, nowMs, english), "warning", 1]),
            [fieldLabels.role, oneLine(agent.role), "plain", 1],
            [fieldLabels.blocker, oneLine(agent.blocker), "danger", 1],
            [fieldLabels.task, oneLine(agent.task), "plain", 2],
            [fieldLabels.next, oneLine(agent.next_step), "plain", 2],
        ];
        return {
            value: `agent:${agent.agent_id}`,
            key: agent.agent_id,
            label: oneLine(agent.name),
            lines: (active, width) => {
                let paintName = style.bold;
                if(active == true) {
                    paintName = (text) => style.bold(style.accent(text));
                }
                else if(receding == true) {
                    paintName = style.dim;
                }
                const unread = unreadText(agent);
                const first: LinePart[] = [
                    { text: padToWidth(activity.indicator(`agent:${agent.agent_id}`, state == "working") + stateLabel(state, english).toLowerCase(), stateWidth), paint: statePaint(style, state) },
                ];
                const name = participantName(agent.name, agent.client, agent.human);
                const nameWidth = Math.min(groupNameWidth, Math.max(4, width - stateWidth - 17));
                const shownName = compactText(name, Math.max(4, nameWidth - displayWidth(unread)), unicode);
                first.push({ text: shownName, paint: paintName });
                if(unread != "") first.push({ text: unread, paint: style.warning });
                const badges = compact ? [] : activity.badge(`agent:${agent.agent_id}`, style);
                let trailing = compact ? [] : [...badges, { text: ` · ${age(agent.updated_at, nowMs, english)}`, paint: style.dim }];
                const padding = " ".repeat(Math.max(2, nameWidth - displayWidth(shownName + unread) + 2));
                const used = first.reduce((total, part) => total + displayWidth(part.text), 0) + padding.length;
                const trailingWidth = trailing.reduce((total, part) => total + displayWidth(part.text), 0);
                let location = agentLocation(agent, Math.max(0, width - used - trailingWidth), unicode, english);
                if(!compact) {
                    const badgeWidth = badges.reduce((total, part) => total + displayWidth(part.text), 0);
                    const expanded = agentLocation(agent, Math.max(0, width - used - badgeWidth), unicode, english);
                    if(displayWidth(expanded.paths[0] ?? "") > displayWidth(location.paths[0] ?? "")) {
                        location = expanded;
                        trailing = badges;
                    }
                }
                if(location.paths.length > 0) {
                    first.push({ text: padding });
                    const baseline = location.reported || agent.editing.length == 0 ? style.dim : undefined;
                    location.paths.forEach((folder, index) => {
                        if(index > 0) {
                            first.push({ text: " · ", paint: style.dim });
                        }
                        const paint = index == 0 && !location.reported ? activity.folderPaint(agent.agent_id, style, baseline) : baseline;
                        first.push({ text: folder, paint });
                    });
                }
                first.push(...trailing);
                if(compact) {
                    const task = oneLine(agent.task);
                    const remaining = width - first.reduce((total, part) => total + displayWidth(part.text), 0) - 3;
                    if(task != "" && remaining >= 6) {
                        first.push({ text: " · ", paint: style.dim }, { text: compactText(task, remaining, unicode), paint: receding ? style.dim : undefined });
                    }
                    return [first];
                }

                const rows = [first];
                for(const [label, text, tone, lineLimit] of fields) {
                    if(text == "") {
                        continue;
                    }
                    let paintText: ((text: string) => string) | undefined = undefined;
                    if(tone == "danger") {
                        paintText = style.danger;
                    }
                    else if(tone == "warning") {
                        paintText = style.warning;
                    }
                    else if(receding == true) {
                        paintText = style.dim;
                    }
                    const indent = Math.min(stateWidth, Math.max(0, width - fieldWidth - 12));
                    const contentWidth = width - indent - fieldWidth;
                    const content = previewText(text, contentWidth, lineLimit, unicode);
                    content.forEach((line, index) => rows.push([
                        { text: " ".repeat(indent) },
                        { text: index == 0 ? padToWidth(label, fieldWidth) : " ".repeat(fieldWidth), paint: style.dim },
                        { text: line, paint: paintText },
                    ]));
                }
                return rows;
            },
        };
    };

    const groups = new Map<string, RoomOverviewAgent[]>();
    for(const agent of agents) {
        let key = agent.workspace_path ?? "";
        if(agent.human == true) {
            key = PEOPLE_GROUP;
        }
        groups.set(key, [...(groups.get(key) ?? []), agent]);
    }
    // A fixed order, by project and then name: a card that changes state keeps its place, so a
    // refresh never moves what the person is looking at (2026-10-26 user decision). State shows in
    // the colors and the status bar; sorting by it moved whole projects as their agents finished.
    const sortedGroups = [...groups.entries()].sort(([leftKey], [rightKey]) => {
        return Number(leftKey == PEOPLE_GROUP) - Number(rightKey == PEOPLE_GROUP)
            || projectName(leftKey, english).localeCompare(projectName(rightKey, english))
            || leftKey.localeCompare(rightKey);
    });
    const projectNameCounts = new Map<string, number>();
    for(const [key] of sortedGroups) {
        if(key != PEOPLE_GROUP) {
            const name = projectName(key, english);
            projectNameCounts.set(name, (projectNameCounts.get(name) ?? 0) + 1);
        }
    }

    const items: SelectItem<BoardValue>[] = [];
    for(const [key, members] of sortedGroups) {
        if(key == PEOPLE_GROUP) {
            items.push({ separator: true, rule: true, label: english ? "People" : "사람" });
        }
        else {
            const name = projectName(key, english);
            let hint: string | undefined;
            if(projectNameCounts.get(name)! > 1) {
                hint = key;
            }
            items.push({ separator: true, rule: true, label: name, hint });
        }
        const sortedMembers = [...members].sort((left, right) => left.name.localeCompare(right.name));
        const groupNameWidth = Math.max(...members.map(nameWidthOf));
        for(const agent of sortedMembers) {
            items.push(agentRow(agent, groupNameWidth));
        }
    }

    if(showEnded == true && inactive.length > 0) {
        items.push({
            separator: true,
            rule: true,
            label: english ? "Ended sessions" : "종료된 세션",
            hint: english ? "left, closed, or silent for 30 minutes" : "퇴장, 종료, 또는 30분 동안 신호 없음",
        });
        const newestFirst = [...inactive].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
        const groupNameWidth = Math.max(...inactive.map(nameWidthOf));
        for(const agent of newestFirst) {
            items.push(agentRow(agent, groupNameWidth));
        }
    }
    return { items: items, inactiveCount: inactive.length };
}

/** One metadata line when it fits; otherwise wrap the complete header, retaining its styles. */
function messageColumns(left: LinePart[], right: LinePart[], width: number): LinePart[][] {
    const text = left.map((part) => part.text).join("");
    const meta = right.map((part) => part.text).join("");
    const gap = width - displayWidth(text) - displayWidth(meta);
    if(gap >= 2) return [[...left, { text: " ".repeat(gap) }, ...right]];
    const parts = [...left, { text: " · ", paint: right[0]?.paint }, ...right];
    const source = parts.map((part) => part.text).join("");
    let offset = 0;
    const ranges = parts.map((part) => {
        const start = offset;
        offset += part.text.length;
        return { part, start, end: offset };
    });
    offset = 0;
    return wrapMessageText(source, width).map((line) => {
        const start = source.indexOf(line, offset);
        const end = start + line.length;
        offset = end;
        return ranges.flatMap((range) => {
            const from = Math.max(start, range.start);
            const to = Math.min(end, range.end);
            return from < to ? [{ ...range.part, text: source.slice(from, to) }] : [];
        });
    });
}

/**
 * The text without a lead naming its sender, `[Name → Recipient] …`, `[Name] …` or
 * `Name → Recipient: …`, which the board already shows; the text itself when nothing else is
 * left.
 */
function withoutSenderLead(text: string, sender: string): string {
    const name = sender.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bracketed = `\\[${name}(?![\\p{L}\\p{N}_])[^\\]\\n]{0,${SENDER_LEAD_SPAN}}\\]`;
    const labelled = `${name}\\s*(?:\\([^)\\n]{0,30}\\))?\\s*(?:(?:→|->)[^:\\n]{0,${SENDER_LEAD_SPAN}})?:`;
    const stripped = text.replace(new RegExp(`^\\s*(?:${bracketed}|${labelled})`, "u"), "").trimStart();
    if(stripped == "") {
        return text;
    }
    return stripped;
}

/**
 * Every kept message as a compact block: one header line and two preview lines; Enter opens the
 * full body. Posts to the whole room come first under Notices, then messages to agents. An open
 * message names whom it still waits on; a resolved one only lacks that mark, and a post never
 * has it. Grouped by sender under a rule with the sender's name, the sender of the newest one
 * first and newest first within a group; rows then name only the recipient, show every topic,
 * and leave a lead repeating the sender out of the preview.
 */
function buildMessageItems(
    messages: RoomOverviewMessage[],
    style: Style,
    options: StatusRenderOptions,
    nowMs: number,
    activity: RoomActivity,
): SelectItem<BoardValue>[] {
    const english = options.language == "en";
    const arrow = options.unicode == false ? "->" : "→";
    const items: SelectItem<BoardValue>[] = [];
    if(messages.length == 0) {
        items.push({ separator: true, label: "", hint: english ? "No messages." : "메시지가 없습니다." });
    }

    const posts = messages.filter((message) => message.posted == true);
    const direct = messages.filter((message) => message.posted == false);
    if(posts.length > 0) {
        items.push({ separator: true, label: english ? "Notices" : "공지" });
        pushGroups(posts, (count) => english ? `${count} post${count == 1 ? "" : "s"}` : `공지 ${count}개`);
        if(direct.length > 0) {
            items.push({ separator: true, label: english ? "Messages" : "메시지" });
        }
    }
    pushGroups(direct, (count) => english ? `${count} message${count == 1 ? "" : "s"}` : `메시지 ${count}개`);
    return items;

    function pushGroups(members: RoomOverviewMessage[], countText: (count: number) => string): void {
        // newest first; a Map keeps insertion order, so the sender of the newest one leads
        const groups = new Map<string, RoomOverviewMessage[]>();
        for(const message of [...members].reverse()) {
            const sender = participantName(message.from_name, message.from_client, message.from_human);
            groups.set(sender, [...(groups.get(sender) ?? []), message]);
        }
        for(const [sender, grouped] of groups) {
            items.push({ separator: true, rule: true, label: sender, hint: countText(grouped.length) });
            for(const message of grouped) {
                items.push(messageRow(message));
            }
        }
    }

    function messageRow(message: RoomOverviewMessage): SelectItem<BoardValue> {
        return {
        value: `message:${message.id}`,
        key: `#${message.id}`,
        label: `#${message.id}`,
        lines: (active, width) => {
            let paintKind = style.dim;
            if(message.kind == "question") {
                paintKind = style.warning;
            }
            else if(message.kind == "notice") {
                paintKind = style.accent;
            }
            else if(message.kind == "reply") {
                paintKind = style.success;
            }
            const title: LinePart[] = [
                { text: `#${message.id} `, paint: style.dim },
                { text: message.kind.toUpperCase(), paint: (text) => style.bold(paintKind(text)) },
            ];
            if(message.reply_to != null) {
                title.push({ text: english ? ` · re #${message.reply_to}` : ` · #${message.reply_to}에 답신`, paint: style.dim });
            }
            // the sender is the group heading, and a post goes to everyone
            if(message.posted == false) {
                title.push(
                    { text: `  ${arrow} `, paint: style.dim },
                    { text: messageRecipientNames(message, english) },
                );
            }
            let when = age(message.at, nowMs, english);
            if(message.edited_at != null) {
                when = english ? `edited ${age(message.edited_at, nowMs, english)}` : `${age(message.edited_at, nowMs, english)} 수정`;
            }
            const meta: LinePart[] = [{ text: when, paint: style.dim }];
            if(message.waiting_on.length > 0) {
                // who it waits on: two names, then a count of the rest
                let names = message.waiting_on.slice(0, PENDING_NAMES_SHOWN).join(", ");
                if(message.waiting_on.length > PENDING_NAMES_SHOWN) {
                    names = `${message.waiting_on[0]} +${message.waiting_on.length - 1}`;
                }
                meta.push(
                    { text: " · ", paint: style.dim },
                    { text: english ? `Pending ${names}` : `확인 대기 ${names}`, paint: style.warning },
                );
            }
            // the activity indicator stands in front of the header; a wrapped header continues under `#`
            const indicator = activity.indicator(`message:${message.id}`);
            const headerWidth = width - displayWidth(indicator);
            const badge = activity.badge(`message:${message.id}`, style);
            const titleWidth = [...title, ...badge, ...meta].reduce((sum, part) => sum + displayWidth(part.text), 0);
            if(titleWidth + 2 <= headerWidth) title.push(...badge);
            const header = messageColumns(title, meta, headerWidth);
            if(active == true) {
                // the selected block's header reads as one bar across the list
                for(const row of header) {
                    const used = row.reduce((sum, part) => sum + displayWidth(part.text), 0);
                    row.push({ text: " ".repeat(Math.max(0, headerWidth - used)) });
                    row.forEach((part, index) => {
                        const paint = part.paint;
                        row[index] = { text: part.text, paint: (text) => style.inverse(paint != null ? paint(text) : text) };
                    });
                }
            }
            const rows = header.map((row, index) => {
                let lead = indicator;
                if(index > 0) {
                    lead = " ".repeat(displayWidth(indicator));
                }
                return [{ text: lead, paint: style.dim }, ...row];
            });
            const indent = " ".repeat(MESSAGE_BODY_INDENT);
            const bodyWidth = width - MESSAGE_BODY_INDENT;
            if(message.topics.length > 0) {
                const topicLabel = english ? "Topics" : "주제";
                for(const line of wrap(`${topicLabel} ${message.topics.join(", ")}`, bodyWidth)) {
                    rows.push([{ text: indent }, { text: line, paint: style.dim }]);
                }
            }
            const preview = withoutSenderLead(message.text, message.from_name);
            for(const line of previewText(preview, bodyWidth, MESSAGE_PREVIEW_LINES, options.unicode ?? true)) {
                rows.push([{ text: indent }, { text: line }]);
            }
            return rows;
        },
        };
    }
}

/**
 * One read of the shared database for the open tab. Called again on every refresh tick, so it
 * must stay a pure read.
 */
function buildView(
    store: RoomStore,
    style: Style,
    options: StatusRenderOptions,
    tab: BoardTab,
    toggles: { showEnded: boolean; compact: boolean },
    activity: RoomActivity,
    searchField: { text: string; placeholder?: string },
): BoardView {
    const english = options.language == "en";
    const overview = store.getRoomOverview(SHARED_ROOM, BOARD_MESSAGE_LIMIT);
    const nowMs = Date.now();
    activity.update(overview.agents, overview.messages, tab, nowMs);
    // the summary and the tab count describe who is around now; ended sessions sit behind the toggle
    const agents = overview.agents.filter((agent) => agent.human == false && isInactive(agent) == false);

    let items: SelectItem<BoardValue>[];
    let defaultValue: BoardValue | undefined;
    let posters: Poster[] = [];
    if(tab == "tab:messages") {
        posters = store.livePosters(nowMs);
        // the actions sit above the list, which can run long (2026-10-26 user decision); the list opens with its own heading
        items = [
            // typing on the row searches message text at once (2026-10-26 user request)
            { value: "search:messages", key: "search", label: english ? "Search messages" : "메시지 검색", hint: english ? "by text, topic or sender" : "내용·주제·보낸 이로", input: searchField },
        ];
        if(posters.length > 0) {
            items.push({
                value: "tidy:posts",
                key: "tidy",
                label: english ? "Ask senders to tidy notices" : "공지 정리 요청",
                hint: english ? `${posters.length} agent${posters.length == 1 ? "" : "s"}` : `에이전트 ${posters.length}명`,
            });
        }
        items.push({ value: "back", label: english ? "Back" : "뒤로" }, { separator: true });
        if(overview.message_count > overview.messages.length) {
            items.push({
                separator: true,
                label: english ? `Showing ${overview.messages.length} of ${overview.message_count} messages` : `메시지 ${overview.message_count}개 중 ${overview.messages.length}개 표시`,
            });
        }
        const messageItems = buildMessageItems(overview.messages, style, options, nowMs, activity);
        defaultValue = messageItems.find((item): item is SelectChoice<BoardValue> => "value" in item)?.value;
        items.push(...messageItems);
    }
    else {
        const built = buildAgentItems(overview.agents, style, english, nowMs, toggles.showEnded, activity, options.unicode ?? true, toggles.compact);
        defaultValue = built.items.find((item): item is SelectChoice<BoardValue> => "value" in item)?.value;
        items = [{ value: "toggle:compact", key: "compact", label: english ? "Compact view" : "간단히 보기", hint: toggles.compact ? (english ? "on" : "켬") : (english ? "off" : "끔") }];
        if(built.inactiveCount > 0) {
            let toggleLabel = english ? `Show ended sessions (${built.inactiveCount})` : `종료된 세션 보기 (${built.inactiveCount})`;
            if(toggles.showEnded == true) {
                toggleLabel = english ? `Hide ended sessions (${built.inactiveCount})` : `종료된 세션 숨기기 (${built.inactiveCount})`;
            }
            items.push({ value: "toggle:ended", key: "ended", label: toggleLabel });
        }
        const flagged = agents.filter(canTakeDownFlagged);
        if(flagged.length > 0) {
            items.push({
                value: "retire:flagged", key: "retire",
                label: english ? `Take down flagged cards (${flagged.length})` : `확인 표시된 카드 내리기 (${flagged.length})`,
                hint: flagged.map((agent) => agent.name).join(", "),
            });
        }
        items.push({ value: "back", label: english ? "Back" : "뒤로" }, { separator: true }, ...built.items);
    }

    const question = `${english ? "Waiting room" : "대합실"} · concos ${CONCOS_VERSION}`;
    const person = overview.agents.find((agent) => agent.human == true && agent.name == os.userInfo().username);
    const pendingCount = person?.pending_count ?? 0;
    const messageLabel = english
        ? `Messages ${overview.message_count} · ${pendingCount} for you`
        : `메시지 ${overview.message_count} · 내 미확인 ${pendingCount}`;
    const tabs: SelectTabs<BoardValue> = {
        active: tab,
        items: [
            { value: "tab:agents", key: "agents", label: english ? `Agents ${agents.length}` : `에이전트 ${agents.length}` },
            { value: "tab:messages", key: "messages", label: messageLabel },
        ],
    };
    const unicode = options.unicode ?? true;
    const banner = [statusBanner(agents, style, english, unicode)];
    const levels = unicode ? "▁▂▃▄▅▆▇█" : "_.,:;ox#";
    const peak = Math.max(1, ...overview.activity.events_per_minute);
    const sparkline = overview.activity.events_per_minute.map((count) => {
        return levels[Math.ceil(count / peak * (levels.length - 1))];
    }).join("");
    const activityLabel = english ? `last 30m · ${overview.activity.active_agent_count} active in 5m` : `최근 30분 · 5분 내 활동 ${overview.activity.active_agent_count}명`;
    const summaryWidth = (options.columns ?? 100) - 3;
    if(displayWidth(`${sparkline}  ${activityLabel}`) > summaryWidth) {
        banner.push([{ text: sparkline, paint: style.accent }], [{ text: activityLabel, paint: style.dim }]);
    }
    else {
        banner.push([{ text: sparkline, paint: style.accent }, { text: `  ${activityLabel}`, paint: style.dim }]);
    }

    const warnings: string[] = [];
    const issueLabels = {
        old_concos: english ? "on old concos" : "이전 concos",
        stuck: english ? "stuck" : "활동 없음",
        duplicate: english ? "duplicate" : "중복",
        unread_unwoken: english ? "unwoken" : "미확인·깨우지 못함",
    };
    for(const [kind, label] of Object.entries(issueLabels)) {
        const count = agents.filter((agent) => agent.issues.some((issue) => issue.kind == kind)).length;
        if(count > 0) {
            warnings.push(`${count} ${label}`);
        }
    }
    const claims = new Map<string, { agents: Set<string>; path: string }>();
    for(const agent of agents) {
        if(agent.workspace_path == null) {
            continue;
        }
        const windows = /^[a-z]:[\\/]|^\\\\/i.test(agent.workspace_path);
        const paths = windows ? path.win32 : path.posix;
        const workspace = paths.normalize(agent.workspace_path.replaceAll("\\", "/"));
        for(const editing of agent.editing) {
            const absolute = paths.resolve(workspace, editing.replaceAll("\\", "/"));
            let key = `${workspace}\0${absolute}`;
            if(windows) {
                key = key.toLowerCase();
            }
            const claim = claims.get(key) ?? { agents: new Set<string>(), path: paths.relative(workspace, absolute).replaceAll("\\", "/") || "." };
            claim.agents.add(agent.agent_id);
            claims.set(key, claim);
        }
    }
    const overlaps = [...claims.values()].filter((claim) => claim.agents.size > 1);
    if(overlaps.length > 0) {
        warnings.push(english ? `${overlaps.length} edit overlap${overlaps.length == 1 ? "" : "s"}` : `편집 겹침 ${overlaps.length}곳`);
    }
    if(warnings.length > 0) {
        let text = `! ${warnings.join(" · ")}`;
        if(overlaps.length > 0) {
            const available = summaryWidth - displayWidth(text) - 2;
            if(available >= 4) {
                text += `: ${shortenPath(overlaps[0].path, available, unicode)}`;
            }
        }
        for(const line of wrap(text, summaryWidth)) {
            banner.push([{ text: line, paint: style.warning }]);
        }
    }
    return { question: question, banner: banner, items: items, defaultValue: defaultValue, tabs: tabs, agents: overview.agents, messages: overview.messages, posters: posters };
}

/** A list the board shows in place: no `✔ question · answer` line is left behind when it closes. */
async function selectInPlace<T extends string>(
    prompter: Prompter,
    question: string,
    items: SelectItem<T>[],
    options: SelectOptions<T>,
): Promise<T> {
    const previous = prompter.transient;
    prompter.transient = true;
    try {
        const picked = await prompter.select(question, items, options);
        return picked;
    }
    finally {
        prompter.transient = previous;
    }
}

async function setName(options: { prompter: Prompter; store: RoomStore; agent: RoomOverviewAgent; english: boolean }): Promise<boolean> {
    const { prompter, store, agent, english } = options;
    const previous = prompter.transient;
    prompter.transient = true;
    let name: string;
    let label = "이름";
    if(english == true) {
        label = "Name";
    }
    try {
        name = await prompter.ask(label, { initialValue: agent.name });
    }
    catch(error) {
        if(error instanceof PromptBackError) {
            return false;
        }
        throw error;
    }
    finally {
        prompter.transient = previous;
    }
    if(name.length == 0 || name.length > MAX_DISPLAY_NAME_LENGTH) {
        let report = `이름은 1~${MAX_DISPLAY_NAME_LENGTH}자여야 합니다. 바꾸지 않았습니다.`;
        if(english == true) {
            report = `A name must contain 1 to ${MAX_DISPLAY_NAME_LENGTH} characters; it was not changed.`;
        }
        await reportInPlace(prompter, report);
        return false;
    }
    if(store.setNameFromBoard(agent.agent_id, name) == false) {
        let report = "같은 방의 다른 활동 중인 카드가 사용 중인 이름입니다. 바꾸지 않았습니다.";
        if(english == true) {
            report = "Another active card in this room already uses that name; it was not changed.";
        }
        await reportInPlace(prompter, report);
        return false;
    }
    return true;
}

/** The role entered in the card form; an empty value or `-` clears it, Esc keeps the saved value. */
async function setRole(prompter: Prompter, store: RoomStore, agent: RoomOverviewAgent, english: boolean): Promise<boolean> {
    const previous = prompter.transient;
    prompter.transient = true;
    let typed: string;
    let label = english ? "Role (clear to remove)" : "역할 (비우면 삭제)";
    if(prompter.isInteractive == false) {
        label = english ? "Role (- to remove)" : "역할 (-로 삭제)";
    }
    try {
        typed = await prompter.ask(label, { initialValue: agent.role });
    }
    catch(error) {
        if(error instanceof PromptBackError) {
            return false;
        }
        throw error;
    }
    finally {
        prompter.transient = previous;
    }
    let role = typed;
    if(typed.trim() == "-") {
        role = "";
    }
    if(role.trim().length > MAX_ROLE_LENGTH) {
        await reportInPlace(prompter, english ? `A role holds at most ${MAX_ROLE_LENGTH} characters; it was not changed.` : `역할은 ${MAX_ROLE_LENGTH}자까지입니다. 바꾸지 않았습니다.`);
        return false;
    }
    store.setRoleFromBoard(agent.agent_id, role);
    return true;
}

async function showAgent(prompter: Prompter, store: RoomStore, agent: RoomOverviewAgent, options: RoomBoardOptions, activity: RoomActivity): Promise<void> {
    const english = options.language == "en";
    type AgentAction = `message:${number}` | "say" | "name" | "role" | "retire" | "back";
    let selected: AgentAction = "name";
    for(;;) {
        const found = store.getRoomOverview(SHARED_ROOM, 0).agents.find((candidate) => candidate.agent_id == agent.agent_id);
        if(found == null) {
            return;
        }
        let current = found;
        // the agent itself is the viewer: inspectAgent only requires both to be in the same room
        let detail = store.inspectAgent(current.agent_id, {
            agentId: current.agent_id,
            checkpointLimit: DETAIL_CHECKPOINT_LIMIT,
            beforeCheckpointId: null,
        });
        let pending = store.pendingFor(current.agent_id);
        let rendered: { header: string; body: string } | null = null;
        let renderedWidth = 0;
        const sections = (width: number) => {
            if(rendered == null || renderedWidth != width) {
                const locationPaint = activity.folderPaint(current.agent_id, prompter.paint, current.editing.length == 0 ? prompter.paint.dim : undefined);
                const renderOptions = { ...options, columns: width + 1, locationPaint };
                const body = renderAgentDetailBody(current, detail, renderOptions).split("\n");
                const folders = recentFolderLines(current, { ...renderOptions, columns: width - 1 });
                if(folders.length > 0) {
                    body.push("", prompter.paint.bold(english ? "Recent folders" : "최근 폴더"));
                    body.push(...folders.map((folder) => `  ${folder.tone == "dim" ? prompter.paint.dim(folder.text) : folder.text}`));
                }
                rendered = { header: renderAgentDetailHeader(current, detail, renderOptions), body: body.join("\n") };
                renderedWidth = width;
            }
            return rendered;
        };
        const frame = () => {
            activity.tick(Date.now());
            rendered = null;
            return {};
        };

        const detailItems = (): SelectItem<AgentAction>[] => {
            const items: SelectItem<AgentAction>[] = [
                { separator: true, lines: (width: number) => sections(width).header.split("\n") },
                { separator: true, rule: true, label: english ? "Card" : "카드" },
            ];
            if(current.human == false) {
                items.push({
                    value: "name", label: english ? "Name" : "이름",
                    hint: `${oneLine(current.name)} · ${english ? "its next join may set it back" : "다음 참가 때 세션 이름으로 돌아갈 수 있음"}`,
                });
                items.push({ value: "role", label: english ? "Role" : "역할", hint: oneLine(current.role) || (english ? "none" : "없음") });
            }
            if(current.human == false && current.left == false) {
                items.push({ value: "say", label: english ? "Send a message" : "메시지 보내기", hint: english ? "to this agent" : "이 에이전트에게" });
                items.push({ separator: true });
                items.push({
                    value: "retire",
                    label: english ? "Take down this card" : "이 카드 내리기",
                    hint: english ? "it leaves the room; unread messages go to the live card of its name" : "대합실에서 빠짐 · 미확인 메시지는 같은 이름의 살아 있는 카드로",
                });
                items.push({ separator: true });
            }
            items.push({ value: "back", label: english ? "Back" : "뒤로" });
            if(pending.length > 0) {
                items.push({ separator: true, rule: true, label: english ? `Waiting messages (${pending.length})` : `미확인 메시지 (${pending.length})` });
                for(const message of pending) {
                    items.push({
                        value: `message:${message.id}`, key: String(message.id), label: `#${message.id}`,
                        lines: (active, width) => pendingMessageLines(message, width, options).map((line) => [{
                            text: line.text,
                            paint: active ? prompter.paint.accent : line.tone == "bold" ? prompter.paint.bold : line.tone == "warning" ? prompter.paint.warning : prompter.paint.dim,
                        }]),
                    });
                }
            }
            items.push({ separator: true, lines: (width: number) => {
                const body = sections(width).body;
                return body.trim() == "" ? [] : ["", ...body.split("\n")];
            } });
            return items;
        };
        const action: AgentAction = await selectInPlace(prompter, participantName(current.name, current.client, current.human), detailItems(), {
            cancelValue: "back", defaultValue: selected, ...frame(),
            animation: { intervalMs: ANIMATION_FRAME_MS, frame },
            refresh: {
                intervalMs: BOARD_REFRESH_MS,
                load: () => {
                    const overview = store.getRoomOverview(SHARED_ROOM, BOARD_MESSAGE_LIMIT);
                    activity.update(overview.agents, overview.messages, "tab:agents", Date.now());
                    const refreshed = overview.agents.find((candidate) => candidate.agent_id == current.agent_id);
                    if(refreshed != null) {
                        current = refreshed;
                        detail = store.inspectAgent(current.agent_id, { agentId: current.agent_id, checkpointLimit: DETAIL_CHECKPOINT_LIMIT, beforeCheckpointId: null });
                        pending = store.pendingFor(current.agent_id);
                    }
                    return { question: participantName(current.name, current.client, current.human), items: detailItems(), ...frame() };
                },
            },
        });
        if(action == "back") {
            return;
        }
        if(action.startsWith("message:")) {
            selected = action;
            const message = store.messageForBoard(Number(action.slice("message:".length)));
            if(message != null) await showMessage(prompter, store, message, options);
            continue;
        }
        if(action == "name") {
            selected = "name";
            if(await setName({ prompter, store, agent: current, english }) == true) {
                selected = "role";
            }
            continue;
        }
        if(action == "role") {
            selected = "role";
            if(await setRole(prompter, store, current, english) == true) {
                selected = current.left == false ? "say" : "back";
            }
            continue;
        }
        if(action == "retire") {
            await takeDownCards(prompter, store, [current], english);
            return;
        }
        selected = "say";
        const mark = prompter.mark();
        try {
            await options.send(current.agent_id);
        }
        catch(error) {
            if((error instanceof PromptBackError) == false) {
                throw error;
            }
        }
        finally {
            prompter.eraseTo(mark);
        }
    }
}

/** A yes/no question the board asks in place: no answered line is left behind, and Esc is no. */
async function confirmInPlace(prompter: Prompter, question: string): Promise<boolean> {
    const previous = prompter.transient;
    prompter.transient = true;
    try {
        const confirmed = await prompter.askYesNo(question, false);
        return confirmed;
    }
    catch(error) {
        if(error instanceof PromptBackError) {
            return false;
        }
        throw error;
    }
    finally {
        prompter.transient = previous;
    }
}

/**
 * The person at the board takes cards down after one question (Enter is no: they leave the
 * room), each as `retireAgent` does, and is told where their unread messages went.
 */
async function takeDownCards(prompter: Prompter, store: RoomStore, cards: RoomOverviewAgent[], english: boolean): Promise<void> {
    const names = cards.map((card) => participantName(card.name, card.client, false)).join(", ");
    const question = english
        ? `Take down ${names}? ${cards.length == 1 ? "It leaves" : "They leave"} the room; a session still using one can join again.`
        : `${names} 카드를 내릴까요? 대합실에서 빠지고, 아직 쓰는 세션은 다시 join할 수 있습니다.`;
    if(await confirmInPlace(prompter, question) == false) {
        return;
    }
    let handedOver = false;
    for(const card of cards) {
        if(store.retireAgent(card.agent_id).moved_to != null) {
            handedOver = true;
        }
    }
    let report = english ? `Took down ${cards.length} card${cards.length == 1 ? "" : "s"}.` : `카드 ${cards.length}개를 내렸습니다.`;
    if(handedOver == true) {
        report += english ? " Any unread messages went to the live card of the same name." : " 미확인 메시지가 있었다면 같은 이름의 살아 있는 카드로 넘겼습니다.";
    }
    await reportInPlace(prompter, report);
}

/** Keeps a short report on screen until Enter or Esc, then takes it away again. */
async function reportInPlace(prompter: Prompter, report: string): Promise<void> {
    prompter.write(`\n${report}\n\n`);
    try {
        await prompter.pause();
    }
    catch(error) {
        if((error instanceof PromptBackError) == false) {
            throw error;
        }
    }
    prompter.eraseLines(writtenLineCount(report));
}

/**
 * Asks every live poster, by question, to remove its posts that no longer apply and rewrite the
 * ones that changed, naming each post by number and first line. A question, so the hooks of
 * Claude Code and Codex continue a turn for it and their idle wake rouses a waiting
 * session (user decision 2026-10-25).
 */
async function askToTidyPosts(prompter: Prompter, store: RoomStore, posters: Poster[], english: boolean): Promise<void> {
    const names = posters.map((poster) => participantName(poster.name, poster.client, false)).join(", ");
    const question = english ? `Ask ${names} to tidy their notices?` : `${names}에게 공지 정리를 요청할까요?`;
    if(await confirmInPlace(prompter, question) == false) {
        return;
    }
    const sender = store.ensureHumanParticipant(SHARED_ROOM, os.userInfo().username);
    for(const poster of posters) {
        const list = poster.posts.map((post) => `#${post.id} ${previewText(post.text, TIDY_PREVIEW_WIDTH, 1)[0] ?? ""}`);
        store.sendMessage(sender, { to: poster.agent_id, kind: "question", text: [TIDY_REQUEST, ...list].join("\n"), replyTo: null, requestId: null });
    }
    let report = english ? `Asked ${posters.length} agents to tidy their notices.` : `에이전트 ${posters.length}명에게 공지 정리를 요청했습니다.`;
    if(english == true && posters.length == 1) {
        report = "Asked 1 agent to tidy its notices.";
    }
    await reportInPlace(prompter, report);
}

async function showMessage(prompter: Prompter, store: RoomStore, message: RoomOverviewMessage, options: RoomBoardOptions): Promise<void> {
    const english = options.language == "en";
    // a person has no check_in: opening a message that names them, alone or in a group, is their
    // acknowledgement. The viewer is the same OS user the menu sends as.
    const person = os.userInfo().username;
    store.acknowledgeForPerson(person, message.id);
    const sender = store.messageSender(message.id);
    const canReply = message.posted || message.recipients.some((recipient) => recipient.human && recipient.name == person);
    const items: SelectItem<"back" | "send" | "remove">[] = [
        { value: "back", label: english ? "Back" : "뒤로" },
    ];
    if(sender != null && sender.human == false && sender.left == false) {
        items.push({ value: "send", key: canReply ? "reply" : "send", label: canReply ? (english ? "Reply to sender" : "보낸 이에게 답장") : (english ? "Message the sender" : "보낸 이에게 메시지") });
    }
    if(message.posted) {
        items.push({ value: "remove", label: english ? "Remove this post" : "이 공지 내리기", hint: english ? "for everyone" : "모두에게서" });
    }
    const action = await selectInPlace(prompter, `#${message.id}`, items, {
        cancelValue: "back", preface: renderMessageDetail(message, options).split("\n"),
    });
    if(action == "send" && sender != null) {
        const mark = prompter.mark();
        try {
            await options.send(sender.agent_id, canReply ? { messageId: message.id, topics: message.topics } : undefined);
        }
        catch(error) {
            if(!(error instanceof PromptBackError)) throw error;
        }
        finally {
            prompter.eraseTo(mark);
        }
    }
    if(action == "remove") {
        const sender = participantName(message.from_name, message.from_client, message.from_human);
        const question = english ? `Remove post #${message.id} by ${sender}?` : `${sender}의 공지 #${message.id}를 내릴까요?`;
        if(await confirmInPlace(prompter, question) == true) {
            store.removePosts(null, [message.id]);
            await reportInPlace(prompter, english ? `Removed post #${message.id}.` : `공지 #${message.id}를 내렸습니다.`);
        }
    }
}

/**
 * The waiting room board: Agents and Messages tabs switched with Tab or ←/→, both updating
 * live. An agent opens its detail card with send actions, a message its whole text, each shown
 * in place of the list. Holds one database connection while open, because opening the database
 * records provenance and would write on every refresh.
 */
export async function showRoomBoard(prompter: Prompter, options: RoomBoardOptions): Promise<void> {
    const english = options.language == "en";
    const database = await openDatabase(resolveDataDirectory());
    try {
        const store = new RoomStore(database);
        // opening the board sweeps too, so residue goes even when no agent bridge is running
        store.cleanUp();
        let tab: BoardTab = "tab:agents";
        const toggles = { showEnded: false, compact: false };
        const activity = new RoomActivity(prompter.isInteractive, prompter.motionEnabled, options.unicode ?? true, english);
        // the Messages tab's search row; kept here so the text outlives each refresh
        const searchField = {
            text: "",
            placeholder: english ? "type text · Enter: topic/sender" : "본문 입력 · Enter: 주제/보낸 이",
        };
        const loadView = () => buildView(store, prompter.paint, options, tab, toggles, activity, searchField);
        let view = loadView();
        const frame = () => {
            activity.tick(Date.now());
            return { question: activity.heading(view.question), tabs: activity.tabs(view.tabs) };
        };
        if(view.agents.length == 0 && view.messages.length == 0) {
            prompter.write(english ? "\nNo agents have joined the shared waiting room yet.\n\n" : "\n아직 공통 대합실에 참가한 에이전트가 없습니다.\n\n");
            await prompter.pause();
            return;
        }

        // The current tab keeps its row after actions; entering another tab starts at its list.
        const selected: Partial<Record<BoardTab, BoardValue>> = {};
        for(;;) {
            const display = frame();
            const picked: BoardValue = await selectInPlace<BoardValue>(prompter, display.question, view.items, {
                tabs: display.tabs,
                banner: view.banner,
                defaultValue: selected[tab] ?? view.defaultValue,
                cancelValue: "back",
                animation: { intervalMs: ANIMATION_FRAME_MS, frame },
                refresh: {
                    intervalMs: BOARD_REFRESH_MS,
                    load: () => {
                        view = loadView();
                        return { ...view, ...frame() };
                    },
                },
            });
            if(picked == "back") {
                return;
            }
            if(picked == "tab:agents" || picked == "tab:messages") {
                tab = picked;
                delete selected[tab];
                view = loadView();
                continue;
            }
            if(picked == "toggle:ended") {
                toggles.showEnded = toggles.showEnded == false;
                selected[tab] = picked;
                view = loadView();
                continue;
            }
            if(picked == "toggle:compact") {
                toggles.compact = toggles.compact == false;
                selected[tab] = picked;
                view = loadView();
                continue;
            }
            if(picked == "tidy:posts") {
                selected[tab] = picked;
                await askToTidyPosts(prompter, store, view.posters, english);
                view = loadView();
                continue;
            }
            if(picked == "search:messages") {
                selected[tab] = picked;
                // text typed on the row shows its results at once; nothing typed asks how to search
                const typed = searchField.text;
                await showMessageSearch(prompter, store, { ...options, text: typed, openMessage: (message) => showMessage(prompter, store, message, options) });
                view = loadView();
                continue;
            }
            if(picked == "retire:flagged") {
                const flagged = view.agents.filter(canTakeDownFlagged);
                await takeDownCards(prompter, store, flagged, english);
                view = loadView();
                continue;
            }

            selected[tab] = picked;
            if(picked.startsWith("message:") == true) {
                const message = view.messages.find((candidate) => `message:${candidate.id}` == picked);
                if(message != null) {
                    await showMessage(prompter, store, message, options);
                }
            }
            else {
                const agent = view.agents.find((candidate) => `agent:${candidate.agent_id}` == picked);
                if(agent != null) {
                    await showAgent(prompter, store, agent, options, activity);
                }
            }
            view = loadView();
        }
    }
    finally {
        database.close();
    }
}
