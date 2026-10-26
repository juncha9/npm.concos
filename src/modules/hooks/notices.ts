import { HOOK_NOTICES_SHOWN } from "../../_defs";
import type { HookNotice } from "../store/room-store";

/**
 * One line naming unread messages by number, sender and first topic; never their text. `unread`
 * counts every unread message for the agent, so the line also tells of the ones no hook points
 * out (answers to answers, answers to others' questions), and a turn started for one reads them too.
 */
export function describeNotices(notices: HookNotice[], unread: number = notices.length): string {
    const named = notices.slice(0, HOOK_NOTICES_SHOWN).map((notice) => {
        let text = `${notice.kind == "reply" ? "answer" : notice.kind} #${notice.id} from ${notice.from_name}`;
        if(notice.topic != null) {
            text += ` [${notice.topic}]`;
        }
        return text;
    });
    if(notices.length > named.length) {
        named.push(`${notices.length - named.length} more`);
    }
    const others = unread - notices.length;
    if(others > 0 && named.length > 0) {
        named.push(`plus ${others} other unread`);
    }
    else if(others > 0) {
        named.push(`${others} message${others == 1 ? "" : "s"}`);
    }
    return `concos: unread for you — ${named.join("; ")}.`;
}

/** The line that wakes a waiting session, from its watch or its MCP server. */
export function describeWake(notices: HookNotice[], unread: number): string {
    return `${describeNotices(notices, unread)} Read them with read_messages, and answer questions with kind reply if they need one.`;
}
