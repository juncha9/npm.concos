import os from "node:os";
import type { MessageKind } from "../../_defs";
import { SHARED_ROOM } from "../../_defs";
import { resolveDataDirectory } from "../../_libs/paths";
import { openDatabase } from "../store/database";
import { RoomStore } from "../store/room-store";
import type { RoomOverviewAgent, RoomOverviewMessage } from "../store/room-store";
import { renderRoomStatus } from "./status-renderer";
import type { StatusRenderOptions } from "./status-renderer";

const STATUS_MESSAGE_LIMIT = 8;

async function openStore(): Promise<{ store: RoomStore; close: () => void }> {
    const database = await openDatabase(resolveDataDirectory());
    return { store: new RoomStore(database), close: () => database.close() };
}

export interface RoomOverview {
    room: string;
    agents: RoomOverviewAgent[];
    messages: RoomOverviewMessage[];
}

/** One snapshot; interactive menus must release the database before waiting for keyboard input. */
export async function readRoomOverviews(_legacyRoom?: string | null): Promise<RoomOverview[]> {
    const { store, close } = await openStore();
    try {
        const overview = store.getRoomOverview(SHARED_ROOM, STATUS_MESSAGE_LIMIT);
        return overview.agents.length == 0 && overview.messages.length == 0 ? [] : [{ room: SHARED_ROOM, ...overview }];
    }
    finally { close(); }
}

export async function runStatus(options: { room?: string | null; json: boolean } & StatusRenderOptions): Promise<string> {
    const overviews = await readRoomOverviews(options.room);
    const english = options.language == "en";
    if(options.json == true) return JSON.stringify(overviews, null, 2);
    if(overviews.length == 0) {
        return english ? "No agents have joined the shared waiting room yet." : "아직 공통 대합실에 참가한 에이전트가 없습니다.";
    }
    return overviews.map((overview) => renderRoomStatus(overview, options)).join("\n\n");
}

/**
 * Stores a message from the person at the terminal. `to` is "all", or one or more agent ids or
 * display names; `topics` are snake_case keys the message is filed under.
 */
export async function runSay(options: {
    room?: string | null;
    to: string | string[];
    text: string;
    kind: MessageKind;
    senderName: string | null;
    language?: "ko" | "en";
    topics?: string[];
}): Promise<string> {
    const { store, close } = await openStore();
    try {
        const room = SHARED_ROOM;
        const english = options.language == "en";
        const senderName = options.senderName ?? os.userInfo().username;
        const senderId = store.ensureHumanParticipant(room, senderName);
        const requested = Array.isArray(options.to) ? options.to : [options.to];
        let recipients: string | string[] = "all";
        if(requested.includes("all") == false) {
            recipients = requested.map((idOrName) => store.findAgentInRoom(room, idOrName));
        }
        const result = store.sendMessage(senderId, {
            to: recipients,
            kind: options.kind,
            text: options.text,
            replyTo: null,
            requestId: null,
            topics: options.topics ?? [],
        });
        let summary = english
            ? `#${result.message_id} stored · Room ${room} · ${result.recipient_count} recipient(s) · Delivered on the next check_in.`
            : `#${result.message_id} 저장됨 · 대합실 ${room} · 수신자 ${result.recipient_count}명 · 상대가 다음 check_in에서 받습니다.`;
        if(result.posted == true) {
            summary = english
                ? `#${result.message_id} posted · Room ${room} · Agents see it on their next check_in, for reference.`
                : `#${result.message_id} 게시됨 · 대합실 ${room} · 에이전트가 다음 check_in에서 참고로 봅니다.`;
        }
        if(result.inactive_recipients != null) {
            summary += english
                ? "\nA recipient's session has ended; it reads this only if that session comes back."
                : "\n받는 세션 중 종료된 것이 있어, 그 세션이 다시 돌아와야 읽습니다.";
        }
        if(result.similar_topics != null) {
            summary += english
                ? `\nNew topic; similar ones already in use: ${result.similar_topics.join(", ")}`
                : `\n새 주제입니다. 이미 쓰이는 비슷한 주제: ${result.similar_topics.join(", ")}`;
        }
        return summary;
    }
    finally {
        close();
    }
}
