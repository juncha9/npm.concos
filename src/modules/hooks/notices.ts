import { HOOK_NOTICES_SHOWN, HOOK_TEXT_LIMIT } from "../../_defs";
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

/** Text that starts or continues a turn, and the messages it carries in full. */
export interface NoticeText {
    text: string;
    /** Messages whose whole text is in `text`: delivered once it went out, received when the turn ends. */
    delivered: number[];
}

/** `body`: a message's text; `whole`: the full text with it. The host's `wakeCarries`. */
type Carries = (body: string, whole: string) => boolean;

/**
 * The notice line, then the full text of every message it points out, in order, for as long as
 * the whole stays within HOOK_TEXT_LIMIT and `carries` lets it through; the turn then needs no
 * read_messages for them. With none carried it is the one line it always was. `ending` closes the
 * text: what to do with them.
 */
function withTexts(
    notices: HookNotice[],
    unread: number,
    ending: { carried: string; reading: string },
    carries: Carries = () => true,
): NoticeText {
    const header = describeNotices(notices, unread);
    const compose = (blocks: string[], rest: boolean) => {
        const reading = rest ? " Read the rest with read_messages." : "";
        return `${header}\n\n${blocks.join("\n\n")}\n\nThe texts above count as read.${reading} ${ending.carried}`;
    };
    const blocks: string[] = [];
    const delivered: number[] = [];
    for(const notice of notices) {
        const block = `#${notice.id} ${notice.kind == "reply" ? "answer" : notice.kind} from ${notice.from_name}:\n${notice.body}`;
        // measured with the longer ending, as if something were left to read
        const whole = compose([...blocks, block], true);
        if(whole.length > HOOK_TEXT_LIMIT || carries(notice.body, whole) == false) {
            continue;
        }
        blocks.push(block);
        delivered.push(notice.id);
    }
    if(delivered.length == 0) {
        return { text: `${header} ${ending.reading}`, delivered: delivered };
    }
    return { text: compose(blocks, delivered.length < unread), delivered: delivered };
}

/** What wakes a waiting session, from its watch, its MCP server or the board. */
export function describeWake(notices: HookNotice[], unread: number, carries?: Carries): NoticeText {
    return withTexts(notices, unread, {
        reading: "Read them with read_messages, and answer questions with kind reply if they need one.",
        carried: "Answer questions with kind reply if they need one.",
    }, carries);
}

/** What continues a turn that was about to end with unread questions or answers. */
export function describeContinue(notices: HookNotice[], unread: number): NoticeText {
    return withTexts(notices, unread, {
        reading: "Read them with read_messages, answer questions with kind reply if they need one, then finish.",
        carried: "Answer questions with kind reply if they need one, then finish.",
    });
}
