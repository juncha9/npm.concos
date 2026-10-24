export const AGENT_STATUSES = ["working", "waiting", "idle", "finished"] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export const MESSAGE_KINDS = ["note", "question", "reply", "notice"] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];

/** send_message `to` value addressing every active participant of the room. */
export const RECIPIENT_ALL = "all";

/** One shared waiting room per local user database; workspace paths identify projects. */
export const SHARED_ROOM = "main";
