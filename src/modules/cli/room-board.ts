import os from "node:os";
import { SHARED_ROOM } from "../../_defs";
import { resolveDataDirectory } from "../../_libs/paths";
import { openDatabase } from "../store/database";
import { RoomStore } from "../store/room-store";
import type { RoomOverviewAgent, RoomOverviewMessage } from "../store/room-store";
import { displayWidth, padToWidth, PromptBackError } from "./prompter";
import type { LinePart, Prompter, SelectItem, SelectOptions, SelectTabs, Style } from "./prompter";
import { age, plain, renderAgentDetail, renderMessageDetail, stateLabel, stateOf, wrap, wrapMessageText, participantName, messageRecipientNames, previewText } from "./status-renderer";
import type { State, StatusRenderOptions } from "./status-renderer";
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
    /** Opens the send flow with the recipient already chosen. */
    send: (agentId: string) => Promise<void>;
}

type BoardTab = ActivityTab;

/** Object rows carry a prefix so an agent id or a message id can never collide with an action value. */
type BoardValue = `agent:${string}` | `message:${number}` | BoardTab | "toggle:ended" | "tidy:posts" | "back";

type Poster = ReturnType<RoomStore["livePosters"]>[number];

/** Left or ended: still on record, folded away on the board. */
function isInactive(agent: RoomOverviewAgent): boolean {
    return agent.left == true || agent.ended == true;
}

interface BoardView {
    question: string;
    items: SelectItem<BoardValue>[];
    tabs: SelectTabs<BoardValue>;
    agents: RoomOverviewAgent[];
    messages: RoomOverviewMessage[];
    /** Live agents with posts, whom "Ask senders to tidy notices" asks; read for the Messages tab only. */
    posters: Poster[];
}

function oneLine(text: string): string {
    return plain(text).replace(/\s+/g, " ").trim();
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

/** Lines a block written with `prompter.write("\n" + text + "\n\n")` occupies on screen. */
function writtenLineCount(text: string): number {
    return text.split("\n").length + 2;
}

/**
 * The Agents tab, grouped by project with blocked and working agents first. Each agent is a
 * state column, its name with the unread count right after it, then its blocker, task and next
 * step on lines aligned under the name.
 */
function buildAgentItems(allAgents: RoomOverviewAgent[], style: Style, english: boolean, nowMs: number, showEnded: boolean, activity: RoomActivity, unicode = true): {
    items: SelectItem<BoardValue>[];
    inactiveCount: number;
} {
    const priority = (agent: RoomOverviewAgent): number => STATE_PRIORITY.indexOf(stateOf(agent));
    const agents = allAgents.filter((agent) => isInactive(agent) == false);
    const inactive = allAgents.filter((agent) => isInactive(agent) == true);
    // fixed widths from every possible value, so a refresh never shifts the columns
    const stateWidth = Math.max(...STATE_PRIORITY.map((state) => displayWidth(stateLabel(state, english).toLowerCase()))) + 2 + (activity.enabled ? 2 : 0);
    const fieldLabels = { blocker: english ? "Blocker" : "막힘", task: english ? "Task" : "작업", next: english ? "Next" : "다음" };
    const fieldWidth = Math.max(...Object.values(fieldLabels).map(displayWidth)) + 2;

    const agentRow = (agent: RoomOverviewAgent): SelectItem<BoardValue> => {
        const state = stateOf(agent);
        const receding = RECEDING_STATES.includes(state);
        const fields: [string, string, boolean][] = [
            [fieldLabels.blocker, oneLine(agent.blocker), true],
            [fieldLabels.task, oneLine(agent.task), false],
            [fieldLabels.next, oneLine(agent.next_step), false],
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
                const first: LinePart[] = [
                    { text: padToWidth(activity.indicator(`agent:${agent.agent_id}`, state == "working") + stateLabel(state, english).toLowerCase(), stateWidth), paint: statePaint(style, state) },
                    { text: participantName(agent.name, agent.client, agent.human), paint: paintName },
                ];
                if(agent.pending_count > 0) {
                    first.push({ text: english ? ` (${agent.pending_count} unread)` : ` (미확인 ${agent.pending_count})`, paint: style.warning });
                }
                first.push(...activity.badge(`agent:${agent.agent_id}`, style));
                first.push({ text: ` · ${age(agent.updated_at, nowMs, english)}`, paint: style.dim });

                const rows = [first];
                for(const [label, text, isBlocker] of fields) {
                    if(text == "") {
                        continue;
                    }
                    let paintText: ((text: string) => string) | undefined = undefined;
                    if(isBlocker == true) {
                        paintText = style.danger;
                    }
                    else if(receding == true) {
                        paintText = style.dim;
                    }
                    const indent = Math.min(stateWidth, Math.max(0, width - fieldWidth - 12));
                    const contentWidth = width - indent - fieldWidth;
                    const content = previewText(text, contentWidth, isBlocker ? 1 : 2, unicode);
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
    const sortedGroups = [...groups.entries()].sort(([leftKey, left], [rightKey, right]) => {
        return Number(leftKey == PEOPLE_GROUP) - Number(rightKey == PEOPLE_GROUP)
            || Math.min(...left.map(priority)) - Math.min(...right.map(priority))
            || leftKey.localeCompare(rightKey);
    });

    const items: SelectItem<BoardValue>[] = [];
    for(const [key, members] of sortedGroups) {
        if(key == PEOPLE_GROUP) {
            items.push({ separator: true, label: english ? "People" : "사람" });
        }
        else {
            items.push({ separator: true, label: projectName(key, english), hint: key });
        }
        const sortedMembers = [...members].sort((left, right) => priority(left) - priority(right) || left.name.localeCompare(right.name));
        for(const agent of sortedMembers) {
            items.push(agentRow(agent));
        }
    }

    if(showEnded == true && inactive.length > 0) {
        items.push({
            separator: true,
            label: english ? "Ended sessions" : "종료된 세션",
            hint: english ? "left, closed, or silent for 30 minutes" : "퇴장, 종료, 또는 30분 동안 신호 없음",
        });
        const newestFirst = [...inactive].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
        for(const agent of newestFirst) {
            items.push(agentRow(agent));
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
    toggles: { showEnded: boolean },
    activity: RoomActivity,
): BoardView {
    const english = options.language == "en";
    const overview = store.getRoomOverview(SHARED_ROOM, BOARD_MESSAGE_LIMIT);
    const nowMs = Date.now();
    activity.update(overview.agents, overview.messages, tab, nowMs);
    // the summary and the tab count describe who is around now; ended sessions sit behind the toggle
    const agents = overview.agents.filter((agent) => agent.human == false && isInactive(agent) == false);

    let items: SelectItem<BoardValue>[];
    let inactiveCount = 0;
    let posters: Poster[] = [];
    if(tab == "tab:messages") {
        items = buildMessageItems(overview.messages, style, options, nowMs, activity);
        posters = store.livePosters(nowMs);
    }
    else {
        const built = buildAgentItems(overview.agents, style, english, nowMs, toggles.showEnded, activity, options.unicode ?? true);
        items = built.items;
        inactiveCount = built.inactiveCount;
    }
    items.push({ separator: true });
    if(inactiveCount > 0) {
        let toggleLabel = english ? `Show ended sessions (${inactiveCount})` : `종료된 세션 보기 (${inactiveCount})`;
        if(toggles.showEnded == true) {
            toggleLabel = english ? "Hide ended sessions" : "종료된 세션 숨기기";
        }
        items.push({ value: "toggle:ended", key: "ended", label: toggleLabel });
    }
    if(posters.length > 0) {
        items.push({
            value: "tidy:posts",
            key: "tidy",
            label: english ? "Ask senders to tidy notices" : "공지 정리 요청",
            hint: english ? `${posters.length} agent${posters.length == 1 ? "" : "s"}` : `에이전트 ${posters.length}명`,
        });
    }
    items.push({ value: "back", label: english ? "Back" : "뒤로" });

    const counts = STATE_PRIORITY.filter((state) => state != "human").flatMap((state) => {
        const count = agents.filter((agent) => stateOf(agent) == state).length;
        if(count == 0) {
            return [];
        }
        return [`${count} ${stateLabel(state, english).toLowerCase()}`];
    });
    const question = [english ? "Waiting room" : "대합실", ...counts].join(" · ");
    // each tab counts the rows it lists
    const messageCount = overview.messages.length;
    const tabs: SelectTabs<BoardValue> = {
        active: tab,
        items: [
            { value: "tab:agents", key: "agents", label: english ? `Agents ${agents.length}` : `에이전트 ${agents.length}` },
            { value: "tab:messages", key: "messages", label: english ? `Messages ${messageCount}` : `메시지 ${messageCount}` },
        ],
    };
    return { question: question, items: items, tabs: tabs, agents: overview.agents, messages: overview.messages, posters: posters };
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

async function showAgent(prompter: Prompter, store: RoomStore, agent: RoomOverviewAgent, options: RoomBoardOptions): Promise<void> {
    const english = options.language == "en";
    // the agent itself is the viewer: inspectAgent only requires both to be in the same room
    const detail = store.inspectAgent(agent.agent_id, {
        agentId: agent.agent_id,
        checkpointLimit: DETAIL_CHECKPOINT_LIMIT,
        beforeCheckpointId: null,
    });
    const card = renderAgentDetail(agent, detail, options);
    prompter.write(`\n${card}\n\n`);

    const items: SelectItem<"say" | "back">[] = [];
    if(agent.human == false && agent.left == false) {
        items.push({ value: "say", label: english ? "Send a message" : "메시지 보내기" });
        items.push({ separator: true });
    }
    items.push({ value: "back", label: english ? "Back" : "뒤로" });
    const action = await selectInPlace(prompter, participantName(agent.name, agent.client, agent.human), items, { cancelValue: "back" });
    if(action == "back") {
        prompter.eraseLines(writtenLineCount(card));
        return;
    }
    try {
        await options.send(agent.agent_id);
    }
    catch(error) {
        // Esc inside the send flow is one level back: the board, not the main menu
        if(error instanceof PromptBackError) {
            return;
        }
        throw error;
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
 * Claude Code and Codex continue a turn for it and Claude Code's idle wake rouses a waiting
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
    const text = renderMessageDetail(message, options);
    prompter.write(`\n${text}\n\n`);
    // a person has no check_in: opening a message that names them, alone or in a group, is their
    // acknowledgement. The viewer is the same OS user the menu sends as.
    store.acknowledgeForPerson(os.userInfo().username, message.id);
    if(message.posted == false) {
        try {
            await prompter.pause();
        }
        catch(error) {
            // Esc after reading goes back to the Messages tab, like Enter
            if((error instanceof PromptBackError) == false) {
                throw error;
            }
        }
        prompter.eraseLines(writtenLineCount(text));
        return;
    }

    // a post: the person at the board may take it down for everyone
    const items: SelectItem<"back" | "remove">[] = [
        { value: "back", label: english ? "Back" : "뒤로" },
        { value: "remove", label: english ? "Remove this post" : "이 공지 내리기", hint: english ? "for everyone" : "모두에게서" },
    ];
    const action = await selectInPlace(prompter, `#${message.id}`, items, { cancelValue: "back" });
    let removed = false;
    if(action == "remove") {
        const sender = participantName(message.from_name, message.from_client, message.from_human);
        const question = english ? `Remove post #${message.id} by ${sender}?` : `${sender}의 공지 #${message.id}를 내릴까요?`;
        if(await confirmInPlace(prompter, question) == true) {
            store.removePosts(null, [message.id]);
            removed = true;
        }
    }
    prompter.eraseLines(writtenLineCount(text));
    if(removed == true) {
        await reportInPlace(prompter, english ? `Removed post #${message.id}.` : `공지 #${message.id}를 내렸습니다.`);
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
        const toggles = { showEnded: false };
        const activity = new RoomActivity(prompter.isInteractive, prompter.motionEnabled, options.unicode ?? true, english);
        const loadView = () => buildView(store, prompter.paint, options, tab, toggles, activity);
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

        // the row each tab was on, so switching back returns to it
        const selected: Partial<Record<BoardTab, BoardValue>> = {};
        for(;;) {
            const display = frame();
            const picked: BoardValue = await selectInPlace<BoardValue>(prompter, display.question, view.items, {
                tabs: display.tabs,
                defaultValue: selected[tab],
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
                view = loadView();
                continue;
            }
            if(picked == "toggle:ended") {
                toggles.showEnded = toggles.showEnded == false;
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
                    await showAgent(prompter, store, agent, options);
                }
            }
            view = loadView();
        }
    }
    finally {
        database.close();
    }
}
