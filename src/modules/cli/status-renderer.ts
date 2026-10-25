import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AgentIssue, InspectResult, RoomOverviewAgent, RoomOverviewMessage } from "../store/room-store";
import { displayWidth } from "./prompter";

export interface StatusRenderOptions {
    language?: "ko" | "en";
    columns?: number;
    color?: boolean;
    unicode?: boolean;
    nowMs?: number;
}

export type State = "blocked" | "working" | "waiting" | "idle" | "finished" | "offline" | "left" | "human";
const STATE_ORDER: State[] = ["blocked", "working", "waiting", "idle", "finished", "offline", "left", "human"];
const STATE_COLORS: Record<State, number> = { blocked: 31, working: 32, waiting: 33, idle: 2, finished: 2, offline: 2, left: 2, human: 36 };
const STATE_LABELS: Record<"ko" | "en", Record<State, string>> = {
    en: { blocked: "BLOCKED", working: "WORKING", waiting: "WAITING", idle: "IDLE", finished: "FINISHED", offline: "OFFLINE", left: "LEFT", human: "HUMAN" },
    ko: { blocked: "막힘", working: "작업 중", waiting: "대기", idle: "유휴", finished: "완료", offline: "연결 끊김", left: "퇴장", human: "사람" },
};

export function stateLabel(state: State, english: boolean): string {
    if(english == true) {
        return STATE_LABELS.en[state];
    }
    return STATE_LABELS.ko[state];
}

/** Keep stored text from changing the terminal layout or its colors. */
export function plain(text: string): string {
    return stripVTControlCharacters(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export function participantName(name: string, client: string, human = false): string {
    const label = plain(name).replace(/\s+/g, " ").trim();
    const kind = plain(client).replace(/\s+/g, " ").trim();
    return human || kind == "" ? label : `${label} (${kind})`;
}

export function messageRecipientNames(message: RoomOverviewMessage, english: boolean): string {
    if(message.recipients.length > 0) {
        return message.recipients.map((recipient) => participantName(recipient.name, recipient.client, recipient.human)).join(", ");
    }
    return plain(message.to_name ?? (english ? "All agents" : "전체 에이전트"));
}

/** Word wrapping, with character boundaries for long paths and unspaced CJK text. */
export function wrap(text: string, width: number): string[] {
    const lines: string[] = [];
    for(const paragraph of plain(text).split("\n")) {
        let line = "";
        for(const word of paragraph.trim().split(/\s+/)) {
            if(word == "") continue;
            if(line != "" && displayWidth(`${line} ${word}`) <= width) {
                line += ` ${word}`;
                continue;
            }
            if(line != "") { lines.push(line); line = ""; }
            for(const character of word) {
                if(displayWidth(line + character) > width && line != "") {
                    lines.push(line);
                    line = "";
                }
                line += character;
            }
        }
        lines.push(line);
    }
    return lines;
}

/** Message paragraphs keep their indentation and spacing; only visual line breaks are added. */
export function wrapMessageText(text: string, width: number): string[] {
    const lines: string[] = [];
    for(const paragraph of plain(text).split("\n")) {
        let line = "";
        for(const character of paragraph) {
            if(line != "" && displayWidth(line + character) > width) {
                const space = line.lastIndexOf(" ");
                if(space > 0 && line.slice(0, space).trim() != "") {
                    lines.push(line.slice(0, space));
                    line = line.slice(space + 1);
                }
                else {
                    lines.push(line);
                    line = "";
                }
            }
            line += character;
        }
        lines.push(line);
    }
    return lines;
}

/** Keep paragraph indentation and align wrapped bullets or numbered items under their text. */
export function wrapMessageBody(text: string, width: number): string[] {
    const lines: string[] = [];
    for(const paragraph of plain(text).split("\n")) {
        if(paragraph.trim() == "") { lines.push(""); continue; }
        const prefix = paragraph.match(/^ *(?:[-+*•]|\d+[.)]) +/)?.[0] ?? paragraph.match(/^ +/)?.[0] ?? "";
        const prefixWidth = displayWidth(prefix);
        if(prefixWidth == 0 || prefixWidth > width - 2) {
            lines.push(...wrapMessageText(paragraph, width));
            continue;
        }
        const content = wrapMessageText(paragraph.slice(prefix.length), width - prefixWidth);
        content.forEach((line, index) => lines.push((index == 0 ? prefix : " ".repeat(prefixWidth)) + line));
    }
    return lines;
}

export function previewText(text: string, width: number, limit: number, unicode = true): string[] {
    const all = wrapMessageBody(text, width).filter((line) => line.trim() != "");
    const lines = all.slice(0, limit);
    if(all.length > limit && lines.length > 0) {
        const ellipsis = unicode ? "…" : ".".repeat(Math.min(3, width));
        const characters = [...lines[lines.length - 1].trimEnd()];
        while(displayWidth(characters.join("") + ellipsis) > width) characters.pop();
        lines[lines.length - 1] = characters.join("").trimEnd() + ellipsis;
    }
    return lines;
}

export function stateOf(agent: RoomOverviewAgent): State {
    if(agent.human) return "human";
    if(agent.left) return "left";
    if(!agent.online) return "offline";
    if(agent.status == "finished") return "finished";
    if(agent.blocker.trim() != "") return "blocked";
    return agent.status;
}

export function age(isoText: string, nowMs: number, english: boolean): string {
    const elapsed = nowMs - Date.parse(isoText);
    if(!Number.isFinite(elapsed)) return english ? "unknown" : "알 수 없음";
    const minutes = Math.max(0, Math.floor(elapsed / 60000));
    if(minutes < 1) return english ? "just now" : "방금";
    if(minutes < 60) return english ? `${minutes}m ago` : `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if(hours < 24) return english ? `${hours}h ago` : `${hours}시간 전`;
    return english ? `${Math.floor(hours / 24)}d ago` : `${Math.floor(hours / 24)}일 전`;
}

/** Where an agent works now, as a path from its project's root when inside it; empty at the root itself. */
export function workFolder(agent: RoomOverviewAgent): string {
    // the folder it reported, else the one its session started in
    const folder = agent.current_directory ?? agent.working_directory;
    if(folder == null) {
        return "";
    }
    if(agent.workspace_path != null) {
        const relative = path.relative(agent.workspace_path, folder);
        // the project root goes without saying: the card sits under it
        if(relative == "") {
            return "";
        }
        if(relative.startsWith("..") == false && path.isAbsolute(relative) == false) {
            return relative.replaceAll(path.sep, "/");
        }
    }
    return folder;
}

/** Why a card looks wrong, and what to do about it, in one line. */
export function issueText(issue: AgentIssue, nowMs: number, english: boolean): string {
    if(issue.kind == "old_concos") {
        return english ? `runs concos ${issue.version} · restart the session` : `concos ${issue.version}로 실행 중 · 세션을 다시 시작하세요`;
    }
    if(issue.kind == "duplicate") {
        return english ? "a newer card has this name · take this one down" : "같은 이름의 새 카드가 있음 · 이 카드를 내리세요";
    }
    return english ? `says working, but last acted ${age(issue.since, nowMs, true)}` : `작업 중이지만 마지막 활동은 ${age(issue.since, nowMs, false)}`;
}

export function renderRoomStatus(overview: {
    agents: RoomOverviewAgent[];
    messages: RoomOverviewMessage[];
}, options: StatusRenderOptions = {}): string {
    const english = options.language == "en";
    const nowMs = options.nowMs ?? Date.now();
    // Leave the last terminal column free, so a report cannot wrap into a prompt.
    const columns = Number.isFinite(options.columns) ? options.columns! : 100;
    const width = Math.max(19, Math.min(120, Math.floor(columns)) - 1);
    const unicode = options.unicode ?? true;
    const paint = (text: string, code: number): string => options.color ? `\u001b[${code}m${text}\u001b[0m` : text;
    const dim = (text: string): string => paint(text, 2);
    let labels = STATE_LABELS.ko;
    if(english == true) {
        labels = STATE_LABELS.en;
    }
    const lines: string[] = [];
    const add = (text: string, prefix = "", style = (value: string) => value): void => {
        for(const line of wrap(text, width - displayWidth(prefix))) lines.push(prefix + style(line));
    };
    const field = (label: string, text: string, warning = false): void => {
        if(text.trim() == "") return;
        const prefix = `    ${label}${" ".repeat(Math.max(1, 9 - displayWidth(label)))}`;
        const content = wrap(text, width - displayWidth(prefix));
        content.forEach((line, index) => {
            const indent = index == 0 ? (warning ? paint(prefix, 31) : dim(prefix)) : " ".repeat(displayWidth(prefix));
            lines.push(indent + (warning ? paint(line, 31) : line));
        });
    };

    // left and ended sessions stay in the JSON output; the report lists who is around now
    const present = overview.agents.filter((agent) => agent.left == false && agent.ended == false);
    const hiddenCount = overview.agents.length - present.length;
    const groups = new Map<string, { path: string | null; people: boolean; agents: RoomOverviewAgent[] }>();
    for(const agent of present) {
        const key = agent.human ? "people" : agent.workspace_path ?? "";
        const group = groups.get(key) ?? { path: agent.human ? null : agent.workspace_path, people: agent.human, agents: [] };
        group.agents.push(agent);
        groups.set(key, group);
    }
    const agents = present.filter((agent) => !agent.human);
    const projects = [...groups.values()].filter((group) => !group.people && group.path != null).length;
    const counts = STATE_ORDER.filter((state) => state != "human").flatMap((state) => {
        const count = agents.filter((agent) => stateOf(agent) == state).length;
        return count == 0 ? [] : [english ? `${count} ${state}` : `${labels[state]} ${count}`];
    });
    const people = present.length - agents.length;
    add(english ? "Shared waiting room" : "공통 대합실", "", (text) => paint(text, 1));
    const summary = english
        ? [`${agents.length} agent${agents.length == 1 ? "" : "s"}`, `${projects} project${projects == 1 ? "" : "s"}`, ...counts]
        : [`에이전트 ${agents.length}명`, `프로젝트 ${projects}개`, ...counts];
    if(people > 0) summary.push(english ? `${people} ${people == 1 ? "person" : "people"}` : `사람 ${people}명`);
    if(hiddenCount > 0) summary.push(english ? `${hiddenCount} ended session${hiddenCount == 1 ? "" : "s"} hidden` : `종료된 세션 ${hiddenCount}개 숨김`);
    add(summary.join(" · "), "", dim);

    const priority = (agent: RoomOverviewAgent): number => STATE_ORDER.indexOf(stateOf(agent));
    const sortedGroups = [...groups.values()].sort((a, b) => Number(a.people) - Number(b.people)
        || Math.min(...a.agents.map(priority)) - Math.min(...b.agents.map(priority))
        || (a.path ?? "").localeCompare(b.path ?? ""));
    for(const group of sortedGroups) {
        lines.push("");
        const name = group.people ? (english ? "People" : "사람")
            : group.path?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || (english ? "No workspace" : "위치 없음");
        const count = english ? `${group.agents.length} ${group.people ? "participant(s)" : group.agents.length == 1 ? "agent" : "agents"}` : `${group.agents.length}명`;
        add(`${name} · ${count}`, "", (text) => paint(text, 36));
        if(group.path != null) add(group.path, "", dim);
        lines.push(dim((unicode ? "─" : "-").repeat(width)));

        const sortedAgents = [...group.agents].sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
        sortedAgents.forEach((agent, index) => {
            if(index > 0) lines.push("");
            const state = stateOf(agent);
            const badge = `[${labels[state]}]`;
            const prefix = `  ${badge} `;
            let unread = "";
            if(agent.pending_count > 0) {
                unread = english ? ` (${agent.pending_count} unread)` : ` (미확인 ${agent.pending_count})`;
            }
            const names = wrap(participantName(agent.name, agent.client, agent.human), width - displayWidth(prefix) - displayWidth(unread));
            names.forEach((nameLine, lineIndex) => {
                const indent = lineIndex == 0 ? `  ${paint(badge, STATE_COLORS[state])} ` : " ".repeat(displayWidth(prefix));
                let line = indent + paint(nameLine, 1);
                if(lineIndex == names.length - 1 && unread != "") {
                    line += paint(unread, 33);
                }
                lines.push(line);
            });
            const connection = agent.human ? "" : agent.left ? (english ? "left" : "퇴장")
                : agent.online ? (english ? "online" : "연결됨") : (english ? "offline" : "연결 끊김");
            add([connection, `${english ? "updated" : "갱신"} ${age(agent.updated_at, nowMs, english)}`, agent.agent_id].filter(Boolean).join(" · "), "    ", dim);
            if(agent.stale && !agent.left && !agent.human) {
                add(english ? "Stale report" : "오래된 상태 보고", "    ", (text) => paint(text, 33));
            }
            for(const issue of agent.issues) {
                add(`${english ? "Check" : "확인"}  ${issueText(issue, nowMs, english)}`, "    ", (text) => paint(text, 33));
            }
            field(english ? "Role" : "역할", agent.role);
            field(english ? "Folder" : "폴더", workFolder(agent));
            field(english ? "Task" : "작업", agent.task);
            field(english ? "Next" : "다음", agent.next_step);
            field(english ? "Blocker" : "막힘", agent.blocker, true);
            field(english ? "Editing" : "편집 중", agent.editing.join(", "));
        });
    }

    if(overview.messages.length > 0) {
        lines.push("");
        add(english ? "Recent messages" : "최근 메시지", "", (text) => paint(text, 1));
        lines.push(dim((unicode ? "─" : "-").repeat(width)));
        for(const message of overview.messages) {
            const recipient = messageRecipientNames(message, english);
            const sender = participantName(message.from_name, message.from_client, message.from_human);
            let heading = `#${message.id} ${sender} ${unicode ? "→" : "->"} ${recipient} [${message.kind}] · ${age(message.at, nowMs, english)}`;
            if(message.edited_at != null) heading += english ? ` · edited ${age(message.edited_at, nowMs, english)}` : ` · ${age(message.edited_at, nowMs, english)} 수정`;
            if(message.reply_to != null) heading += english ? ` · reply to #${message.reply_to}` : ` · #${message.reply_to}에 답신`;
            add(heading, "  ", dim);
            const [firstLine, ...rest] = plain(message.text).split("\n");
            add(firstLine + (rest.length > 0 ? (unicode ? " …" : " ...") : ""), "    ");
        }
    }
    return lines.join("\n").trimEnd();
}

function detailWidth(options: StatusRenderOptions): number {
    const columns = Number.isFinite(options.columns) ? options.columns! : 100;
    return Math.max(19, Math.min(120, Math.floor(columns)) - 1);
}

/**
 * One agent's full card and recent checkpoints, for the waiting room board's detail view.
 * The board list shows one line per agent; this is where the long fields are read.
 */
export function renderAgentDetail(agent: RoomOverviewAgent, detail: InspectResult, options: StatusRenderOptions = {}): string {
    const english = options.language == "en";
    const nowMs = options.nowMs ?? Date.now();
    const width = detailWidth(options);
    const unicode = options.unicode ?? true;
    const paint = (text: string, code: number): string => {
        if(options.color == true) {
            return `\u001b[${code}m${text}\u001b[0m`;
        }
        return text;
    };
    const lines: string[] = [];
    const add = (text: string, prefix: string, code: number | null): void => {
        for(const line of wrap(text, width - displayWidth(prefix))) {
            if(code == null) {
                lines.push(prefix + line);
            }
            else {
                lines.push(prefix + paint(line, code));
            }
        }
    };
    const field = (label: string, text: string, code: number | null = null): void => {
        if(text.trim() == "") {
            return;
        }
        const prefix = `${label}${" ".repeat(Math.max(1, 12 - displayWidth(label)))}`;
        wrap(text, width - displayWidth(prefix)).forEach((line, index) => {
            let indent = " ".repeat(displayWidth(prefix));
            if(index == 0) {
                indent = paint(prefix, code ?? 2);
            }
            if(code == null) {
                lines.push(indent + line);
            }
            else {
                lines.push(indent + paint(line, code));
            }
        });
    };

    const state = stateOf(agent);
    const card = detail.card;
    // same shape as the board row the card was opened from: state word, then name
    const stateText = `${stateLabel(state, english).toLowerCase()}  `;
    let unread = "";
    if(agent.pending_count > 0) {
        unread = english ? ` (${agent.pending_count} unread)` : ` (미확인 ${agent.pending_count})`;
    }
    // wrapped like every other line: the board erases the card by its line count when it returns
    const nameLines = wrap(participantName(card.name, card.client, card.human), Math.max(10, width - displayWidth(stateText) - displayWidth(unread)));
    nameLines.forEach((nameLine, lineIndex) => {
        let line = `${" ".repeat(displayWidth(stateText))}${paint(nameLine, 1)}`;
        if(lineIndex == 0) {
            line = `${paint(stateText.trimEnd(), STATE_COLORS[state])}  ${paint(nameLine, 1)}`;
        }
        if(lineIndex == nameLines.length - 1 && unread != "") {
            line += paint(unread, 33);
        }
        lines.push(line);
    });
    let connection = english ? "online" : "연결됨";
    if(card.left == true) {
        connection = english ? "left" : "퇴장";
    }
    else if(card.online == false) {
        connection = english ? "offline" : "연결 끊김";
    }
    const version = agent.concos_version == null ? [] : [`concos ${agent.concos_version}`];
    add([card.client, connection, `${english ? "updated" : "갱신"} ${age(card.updated_at, nowMs, english)}`, ...version, card.agent_id].join(" · "), "", 2);
    if(card.workspace != null) {
        add(card.workspace.path, "", 2);
    }
    lines.push(paint((unicode ? "─" : "-").repeat(width), 2));
    for(const issue of agent.issues) {
        field(english ? "Check" : "확인", issueText(issue, nowMs, english), 33);
    }
    field(english ? "Role" : "역할", card.role);
    field(english ? "Folder" : "폴더", workFolder(agent));
    field(english ? "Blocker" : "막힘", card.blocker, 31);
    field(english ? "Task" : "작업", card.task);
    field(english ? "Summary" : "요약", card.summary);
    field(english ? "Next" : "다음", card.next_step);
    field(english ? "Editing" : "편집 중", card.editing.join(", "));
    field(english ? "References" : "참고", card.references.join(", "));

    if(detail.checkpoints.length > 0) {
        lines.push("");
        add(english ? "Checkpoints" : "체크포인트", "", 1);
        for(const checkpoint of detail.checkpoints) {
            add(age(checkpoint.at, nowMs, english), "  ", 2);
            add(checkpoint.text, "    ", null);
        }
    }
    return lines.join("\n");
}

/** One message in full, for the board's message view; the room report shows only first lines. */
export function renderMessageDetail(message: RoomOverviewMessage, options: StatusRenderOptions = {}): string {
    const english = options.language == "en";
    const nowMs = options.nowMs ?? Date.now();
    const width = detailWidth(options);
    const unicode = options.unicode ?? true;
    const paint = (text: string, code: number): string => options.color ? `\u001b[${code}m${text}\u001b[0m` : text;
    const lines = wrap(`#${message.id} [${message.kind.toUpperCase()}]`, width).map((line) => paint(line, 1));
    const field = (label: string, value: string, code = 0): void => {
        const prefix = `${label}  `;
        wrap(value, Math.max(1, width - displayWidth(prefix))).forEach((line, index) => {
            const indent = index == 0 ? paint(prefix, 2) : " ".repeat(displayWidth(prefix));
            lines.push(indent + (code == 0 ? line : paint(line, code)));
        });
    };
    field(english ? "From" : "발신", participantName(message.from_name, message.from_client, message.from_human));
    let recipients = messageRecipientNames(message, english);
    if(message.posted == true) {
        recipients = english ? "All agents, posted for reference" : "전체 에이전트, 참고용 게시";
    }
    field(english ? "To" : "수신", recipients);
    field(english ? "Sent" : "발송", age(message.at, nowMs, english));
    if(message.edited_at != null) field(english ? "Edited" : "수정", age(message.edited_at, nowMs, english));
    if(message.reply_to != null) field(english ? "Reply to" : "원문", `#${message.reply_to}`);
    if(message.waiting_on.length > 0) {
        field(english ? "Awaiting" : "확인 대기", message.waiting_on_participants.map((participant) => participantName(participant.name, participant.client, participant.human)).join(", "), 33);
    }
    lines.push("", paint((unicode ? "─" : "-").repeat(width), 2), "");
    lines.push(...wrapMessageBody(message.text, width - 2).map((line) => line == "" ? "" : `  ${line}`));
    return lines.join("\n");
}
