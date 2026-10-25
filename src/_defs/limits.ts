export const MAX_ROOM_LENGTH = 60;
export const MAX_DISPLAY_NAME_LENGTH = 60;
export const MAX_CLIENT_LENGTH = 40;
export const MAX_PATH_LENGTH = 1000;
export const MAX_TASK_LENGTH = 200;
export const MAX_ROLE_LENGTH = 200;
export const MAX_SUMMARY_LENGTH = 2000;
export const MAX_NEXT_STEP_LENGTH = 300;
export const MAX_BLOCKER_LENGTH = 300;
export const MAX_LIST_ITEMS = 20;
export const MAX_LIST_ITEM_LENGTH = 300;
export const MAX_CHECKPOINT_LENGTH = 2000;
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_RECEIVED_IDS = 50;
/** Agents one message can name at once; more than this is what `all` is for. */
export const MAX_RECIPIENTS = 10;
export const MAX_TOPICS_PER_MESSAGE = 3;
/** A topic key: two to six lowercase words joined by underscores, broad to narrow. */
export const TOPIC_KEY_PATTERN = /^[a-z0-9]+(_[a-z0-9]+){1,5}$/;
export const MAX_TOPIC_KEY_LENGTH = 48;
export const MIN_TOPIC_KEY_LENGTH = 3;
/** Existing topics suggested back when a message introduces a new one. */
export const MAX_SIMILAR_TOPICS = 5;
/** Unread messages a hook names in its one line; the rest are counted. */
export const HOOK_NOTICES_SHOWN = 3;
/** Claude Code idle wake: a session wakes only after this long without a prompt since its turn ended. */
export const WAKE_IDLE_MS = 60 * 1000;
export const WAKE_POLL_MS = 3 * 1000;
/** One watch's life; the registered hook timeout adds a minute so the watch ends on its own first. */
export const WAKE_WATCH_MS = 60 * 60 * 1000;
export const WAKE_HOURLY_LIMIT = 4;
export const MAX_REQUEST_ID_LENGTH = 100;

export const CHECK_IN_MAX_AGENTS = 3;
export const CHECK_IN_MAX_MESSAGES = 3;
export const CHECK_IN_MAX_CHARS = 1500;
export const CARD_FIELD_PREVIEW_LENGTH = 120;
export const MESSAGE_PREVIEW_LENGTH = 200;
export const READ_MESSAGES_DEFAULT_LIMIT = 5;
export const READ_MESSAGES_MAX_LIMIT = 10;
export const INSPECT_CHECKPOINT_DEFAULT_LIMIT = 3;
export const INSPECT_CHECKPOINT_MAX_LIMIT = 10;

export const STALE_CARD_MS = 60 * 60 * 1000;
export const OFFLINE_AFTER_MS = 3 * 60 * 1000;
/**
 * A session counts as ended once its bridge or host session has closed, or after this long
 * without a tool call, hook event or heartbeat. Ended sessions stay on record but drop out of
 * other agents' check_in and the board; any later call brings them back.
 */
export const ENDED_AFTER_MS = 30 * 60 * 1000;
/**
 * A message stays at most this long after it was sent (a post: after its last edit), read or not,
 * so a session that closed for the night and comes back still gets it. A day was where returning
 * sessions stopped losing messages in a simulation.
 */
export const MESSAGE_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A message to agents goes this long after its last recipient read it; a question waits for its answer to be read too. */
export const READ_MESSAGE_GRACE_MS = 60 * 60 * 1000;
/** Posts to the whole room kept per sender: the newest ones. */
export const POSTS_PER_AGENT = 3;
/**
 * A message waits only on agents that called a concos tool or ran a hook this recently. A session
 * left open but idle keeps its bridge heartbeat, so it would otherwise be waited on forever.
 */
export const AWAIT_AFTER_MS = 30 * 60 * 1000;
/**
 * An agent card with no activity for this long is deleted with its checkpoints: its last
 * summary stays available for handoff that long, then it is residue.
 */
export const AGENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Checkpoints kept per agent; older ones are deleted, so one long session cannot grow without bound. */
export const CHECKPOINT_KEEP_PER_AGENT = 50;
export const HEARTBEAT_INTERVAL_MS = 60 * 1000;
