import { HOOK_NOTICES_SHOWN } from "../../_defs";
import type { HookNotice } from "../store/room-store";

/** One line naming unread messages by number, sender and first topic; never their text. */
export function describeNotices(notices: HookNotice[]): string {
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
    return `concos: unread for you — ${named.join("; ")}.`;
}
