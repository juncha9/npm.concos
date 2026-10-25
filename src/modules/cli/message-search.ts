import { RoomError } from "../store/room-error";
import type { MessageSearchInput, MessageSearchResult, RoomOverviewMessage, RoomStore } from "../store/room-store";
import { PromptBackError } from "./prompter";
import type { LinePart, Prompter, SelectItem } from "./prompter";
import { messageRecipientNames, participantName, plain, previewText, renderMessageDetail, wrap } from "./status-renderer";
import type { StatusRenderOptions } from "./status-renderer";

export interface MessageSearchOptions extends StatusRenderOptions {
    /** Most recent matches to show, from 1 to 100; defaults to 50. */
    limit?: number;
}

type SearchField = "text" | "topic" | "sender";
type SearchValue = `message:${number}` | "back";

const SEARCH_LABELS = {
    en: {
        text: "Message text", topic: "Topic key", sender: "Sender name",
        searchBy: "Search messages by", search: "Message search", message: "Message",
        topics: "Topics", none: "none", back: "Back", searchAgain: "Search again",
        narrowerTopics: "including narrower topics", tryAgain: "Try again",
        noResults: "No messages found", narrowSearch: "narrow your search for more",
    },
    ko: {
        text: "메시지 본문", topic: "주제 키", sender: "보낸 이 이름",
        searchBy: "메시지 검색 기준", search: "메시지 검색", message: "메시지",
        topics: "주제", none: "없음", back: "뒤로", searchAgain: "다시 검색",
        narrowerTopics: "하위 주제 포함", tryAgain: "다시 입력",
        noResults: "검색 결과가 없습니다", narrowSearch: "검색어를 좁혀 주세요",
    },
};

function resultItem(message: RoomOverviewMessage, prompter: Prompter, options: MessageSearchOptions): SelectItem<SearchValue> {
    const english = options.language == "en";
    const labels = SEARCH_LABELS[options.language ?? "ko"];
    const unicode = options.unicode ?? true;
    const from = participantName(message.from_name, message.from_client, message.from_human);
    const to = messageRecipientNames(message, english);
    let arrow = "→";
    if(unicode == false) {
        arrow = "->";
    }
    const header = `#${message.id} ${from} ${arrow} ${to}`;
    const firstLine = plain(message.text).split("\n").find((line) => line.trim() != "") ?? "";
    return {
        value: `message:${message.id}`,
        key: `message:${message.id}`,
        label: header,
        lines: (active, width) => {
            let paintHeader = prompter.paint.bold;
            if(active == true) {
                paintHeader = (value) => prompter.paint.bold(prompter.paint.accent(value));
            }
            const rows: LinePart[][] = wrap(header, width).map((text) => [{
                text: text,
                paint: paintHeader,
            }]);
            const bodyWidth = Math.max(1, width - 2);
            let topics = labels.none;
            if(message.topics.length > 0) {
                topics = message.topics.join(", ");
            }
            for(const text of wrap(`${labels.topics} ${topics}`, bodyWidth)) {
                rows.push([{ text: "  " }, { text: text, paint: prompter.paint.dim }]);
            }
            for(const text of previewText(firstLine, bodyWidth, 1, unicode)) {
                rows.push([{ text: "  " }, { text: text }]);
            }
            return rows;
        },
    };
}

/** Detail owns a Back choice in line mode too, so Esc returns to the results before the query. */
async function showDetail(prompter: Prompter, message: RoomOverviewMessage, options: MessageSearchOptions): Promise<void> {
    const labels = SEARCH_LABELS[options.language ?? "ko"];
    const mark = prompter.mark();
    try {
        prompter.write(`\n${renderMessageDetail(message, options)}\n\n`);
        await prompter.select(`${labels.message} #${message.id}`, [
            { value: "back", label: labels.back },
        ], { cancelValue: "back" });
    }
    finally {
        prompter.eraseTo(mark);
    }
}

async function showResults(prompter: Prompter, result: MessageSearchResult, query: string, options: MessageSearchOptions): Promise<void> {
    const english = options.language == "en";
    const labels = SEARCH_LABELS[options.language ?? "ko"];
    const count = result.messages.length;
    let summary = `결과 ${count}개`;
    if(english == true) {
        summary = `${count} results`;
        if(count == 1) {
            summary = "1 result";
        }
    }
    if(count == 0) {
        summary = labels.noResults;
    }
    else if(result.has_more == true) {
        if(english == true) {
            summary = `Newest ${summary}`;
        }
        else {
            summary = `최근 ${summary}`;
        }
        summary += ` · ${labels.narrowSearch}`;
    }
    const title = `${labels.search} · ${plain(query).replace(/\s+/g, " ")} · ${summary}`;
    const items: SelectItem<SearchValue>[] = result.messages.map((message) => resultItem(message, prompter, options));
    if(count > 0) {
        items.push({ separator: true });
    }
    items.push({ value: "back", label: labels.searchAgain });
    let selected: SearchValue | undefined;
    for(;;) {
        const picked: SearchValue = await prompter.select(title, items, { cancelValue: "back", defaultValue: selected });
        if(picked == "back") {
            return;
        }
        selected = picked;
        const message = result.messages.find((entry) => `message:${entry.id}` == picked);
        if(message != null) {
            await showDetail(prompter, message, options);
        }
    }
}

/** A read-only search: field → query → results → detail; Esc returns exactly one level. */
export async function showMessageSearch(prompter: Prompter, store: RoomStore, options: MessageSearchOptions = {}): Promise<void> {
    const labels = SEARCH_LABELS[options.language ?? "ko"];
    const mark = prompter.mark();
    const previousTransient = prompter.transient;
    prompter.transient = true;
    let selectedField: SearchField = "text";
    const queries: Partial<Record<SearchField, string>> = {};
    try {
        for(;;) {
            const items: SelectItem<SearchField | "back">[] = [
                { value: "text", label: labels.text },
                { value: "topic", label: labels.topic, hint: labels.narrowerTopics },
                { value: "sender", label: labels.sender },
                { separator: true },
                { value: "back", label: labels.back },
            ];
            const field: SearchField | "back" = await prompter.select<SearchField | "back">(labels.searchBy, items, {
                defaultValue: selectedField, cancelValue: "back",
            });
            if(field == "back") {
                return;
            }
            selectedField = field;
            for(;;) {
                let query: string;
                try {
                    query = await prompter.askRequired(labels[field], queries[field]);
                }
                catch(error) {
                    if(error instanceof PromptBackError) {
                        break;
                    }
                    throw error;
                }
                queries[field] = query;
                const input: MessageSearchInput = { [field]: query, limit: options.limit };
                let result: MessageSearchResult;
                try {
                    result = store.searchMessages(input);
                }
                catch(error) {
                    if((error instanceof RoomError) == false) {
                        throw error;
                    }
                    await prompter.select(plain(error.message), [{ value: "back", label: labels.tryAgain }], { cancelValue: "back" });
                    continue;
                }
                await showResults(prompter, result, query, options);
            }
        }
    }
    finally {
        prompter.eraseTo(mark);
        prompter.transient = previousTransient;
    }
}
