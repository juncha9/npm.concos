/**
 * Forward migration steps. Index 0 is schema version 1.
 * A step that has shipped is never edited; changes go into the next step.
 * Every table here is a record (the only copy of agent-reported work), not a cache.
 */
export const SCHEMA_STEPS: readonly string[] = [
    `
    CREATE TABLE meta (
        key    TEXT NOT NULL,
        value  TEXT NOT NULL,

        CONSTRAINT pk_meta PRIMARY KEY (key)
    );

    INSERT INTO meta (key, value) VALUES ('last_seq', '0');

    CREATE TABLE workspace (
        id            TEXT    NOT NULL,
        display_path  TEXT    NOT NULL,
        compare_path  TEXT    NOT NULL,
        is_verified   INTEGER NOT NULL,
        created_at    TEXT    NOT NULL,

        CONSTRAINT pk_workspace PRIMARY KEY (id),
        CONSTRAINT uk_workspace_compare_path UNIQUE (compare_path),
        CONSTRAINT ck_workspace_is_verified CHECK (is_verified IN (0, 1))
    );

    CREATE TABLE agent (
        id                  TEXT    NOT NULL,
        room                TEXT    NOT NULL,
        handle_hash         TEXT    NOT NULL,
        display_name        TEXT    NOT NULL,
        client              TEXT    NOT NULL,
        is_human            INTEGER NOT NULL DEFAULT 0,
        workspace_id        TEXT,
        working_directory   TEXT,
        status              TEXT    NOT NULL DEFAULT 'working',
        task                TEXT    NOT NULL DEFAULT '',
        summary             TEXT    NOT NULL DEFAULT '',
        next_step           TEXT    NOT NULL DEFAULT '',
        blocker             TEXT    NOT NULL DEFAULT '',
        reference_list      TEXT    NOT NULL DEFAULT '[]',
        editing_list        TEXT    NOT NULL DEFAULT '[]',
        revision            INTEGER NOT NULL DEFAULT 1,
        changed_seq         INTEGER NOT NULL,
        delivered_seq       INTEGER NOT NULL DEFAULT 0,
        joined_at           TEXT    NOT NULL,
        updated_at          TEXT    NOT NULL,
        editing_updated_at  TEXT,
        last_seen_at        TEXT    NOT NULL,
        disconnected_at     TEXT,
        left_at             TEXT,

        CONSTRAINT pk_agent PRIMARY KEY (id),
        CONSTRAINT uk_agent_handle_hash UNIQUE (handle_hash),
        CONSTRAINT fk_agent_workspace_id
            FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
        CONSTRAINT ck_agent_status_valid
            CHECK (status IN ('working', 'waiting', 'idle', 'finished')),
        CONSTRAINT ck_agent_is_human CHECK (is_human IN (0, 1))
    );

    CREATE INDEX idx_agent_room_changed_seq ON agent (room, changed_seq);
    CREATE INDEX idx_agent_workspace_id ON agent (workspace_id);

    CREATE TABLE checkpoint (
        id            INTEGER NOT NULL,
        agent_id      TEXT    NOT NULL,
        workspace_id  TEXT,
        body          TEXT    NOT NULL,
        created_at    TEXT    NOT NULL,

        CONSTRAINT pk_checkpoint PRIMARY KEY (id),
        CONSTRAINT fk_checkpoint_agent_id
            FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE RESTRICT,
        CONSTRAINT fk_checkpoint_workspace_id
            FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT
    );

    CREATE INDEX idx_checkpoint_agent_id_id ON checkpoint (agent_id, id DESC);
    CREATE INDEX idx_checkpoint_workspace_id ON checkpoint (workspace_id);

    CREATE TABLE message (
        id                   INTEGER NOT NULL,
        seq                  INTEGER NOT NULL,
        room                 TEXT    NOT NULL,
        sender_agent_id      TEXT    NOT NULL,
        recipient_agent_id   TEXT,
        kind                 TEXT    NOT NULL,
        reply_to_message_id  INTEGER,
        body                 TEXT    NOT NULL,
        workspace_id         TEXT,
        request_id           TEXT,
        created_at           TEXT    NOT NULL,

        CONSTRAINT pk_message PRIMARY KEY (id),
        CONSTRAINT uk_message_seq UNIQUE (seq),
        CONSTRAINT uk_message_sender_agent_id_request_id UNIQUE (sender_agent_id, request_id),
        CONSTRAINT fk_message_sender_agent_id
            FOREIGN KEY (sender_agent_id) REFERENCES agent (id) ON DELETE RESTRICT,
        CONSTRAINT fk_message_recipient_agent_id
            FOREIGN KEY (recipient_agent_id) REFERENCES agent (id) ON DELETE RESTRICT,
        CONSTRAINT fk_message_reply_to_message_id
            FOREIGN KEY (reply_to_message_id) REFERENCES message (id) ON DELETE RESTRICT,
        CONSTRAINT fk_message_workspace_id
            FOREIGN KEY (workspace_id) REFERENCES workspace (id) ON DELETE RESTRICT,
        CONSTRAINT ck_message_kind_valid
            CHECK (kind IN ('note', 'question', 'reply', 'notice'))
    );

    CREATE INDEX idx_message_room_seq ON message (room, seq);
    CREATE INDEX idx_message_recipient_agent_id ON message (recipient_agent_id);
    CREATE INDEX idx_message_reply_to_message_id ON message (reply_to_message_id);
    CREATE INDEX idx_message_workspace_id ON message (workspace_id);

    CREATE TABLE message_receipt (
        message_id   INTEGER NOT NULL,
        agent_id     TEXT    NOT NULL,
        received_at  TEXT,

        CONSTRAINT pk_message_receipt PRIMARY KEY (message_id, agent_id),
        CONSTRAINT fk_message_receipt_message_id
            FOREIGN KEY (message_id) REFERENCES message (id) ON DELETE RESTRICT,
        CONSTRAINT fk_message_receipt_agent_id
            FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE RESTRICT
    );

    CREATE INDEX idx_message_receipt_agent_id_received_at ON message_receipt (agent_id, received_at);
    `,
    `
    ALTER TABLE agent ADD COLUMN host TEXT;
    ALTER TABLE agent ADD COLUMN host_session_id TEXT;
    CREATE UNIQUE INDEX uk_agent_host_session ON agent (host, host_session_id)
        WHERE host IS NOT NULL AND host_session_id IS NOT NULL;
    INSERT INTO meta (key, value) VALUES ('hook_handle_secret', lower(hex(randomblob(32))));
    `,
    `
    -- Keep every identity, handle, checkpoint, message and receipt. Re-sequence cards
    -- individually so existing check_in cursors can discover all participants.
    WITH ordered AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS offset FROM agent
    )
    UPDATE agent SET room = 'main',
        changed_seq = (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'last_seq')
            + (SELECT offset FROM ordered WHERE ordered.id = agent.id),
        revision = revision + 1;
    UPDATE meta SET value = CAST(value AS INTEGER) + (SELECT COUNT(*) FROM agent)
        WHERE key = 'last_seq';
    UPDATE message SET room = 'main';

    CREATE TRIGGER agent_shared_room_insert BEFORE INSERT ON agent
        WHEN NEW.room <> 'main' BEGIN SELECT RAISE(ABORT, 'only the shared room is supported'); END;
    CREATE TRIGGER agent_shared_room_update BEFORE UPDATE OF room ON agent
        WHEN NEW.room <> 'main' BEGIN SELECT RAISE(ABORT, 'only the shared room is supported'); END;
    CREATE TRIGGER message_shared_room_insert BEFORE INSERT ON message
        WHEN NEW.room <> 'main' BEGIN SELECT RAISE(ABORT, 'only the shared room is supported'); END;
    CREATE TRIGGER message_shared_room_update BEFORE UPDATE OF room ON message
        WHEN NEW.room <> 'main' BEGIN SELECT RAISE(ABORT, 'only the shared room is supported'); END;
    `,
    `
    -- Who a message went to: one agent, several (receipts name them), or the whole room.
    ALTER TABLE message ADD COLUMN recipient_scope TEXT NOT NULL DEFAULT 'direct'
        CONSTRAINT ck_message_recipient_scope_valid CHECK (recipient_scope IN ('direct', 'group', 'all'));
    UPDATE message SET recipient_scope = 'all' WHERE recipient_agent_id IS NULL;

    -- Up to three snake_case topic keys per message, in the order the sender gave them.
    CREATE TABLE message_topic (
        message_id  INTEGER NOT NULL,
        topic_key   TEXT    NOT NULL,
        position    INTEGER NOT NULL,

        CONSTRAINT pk_message_topic PRIMARY KEY (message_id, topic_key),
        CONSTRAINT fk_message_topic_message_id
            FOREIGN KEY (message_id) REFERENCES message (id) ON DELETE RESTRICT,
        CONSTRAINT ck_message_topic_key_length CHECK (length(topic_key) BETWEEN 3 AND 48)
    );

    CREATE INDEX idx_message_topic_topic_key ON message_topic (topic_key);
    `,
    `
    -- A turn-end hook continues a turn once per message: the newest message seq it has pointed out.
    ALTER TABLE agent ADD COLUMN hook_nudged_seq INTEGER NOT NULL DEFAULT 0;
    `,
    `
    -- Claude Code idle wake: the live watch's generation (a newer watch or a prompt ends older
    -- ones) and when the session was woken, for the hourly limit: JSON array of ISO times.
    ALTER TABLE agent ADD COLUMN wake_generation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent ADD COLUMN woken_at_list TEXT NOT NULL DEFAULT '[]';
    `,
    `
    -- When the agent itself last acted: a concos tool call or a hook event, never the bridge
    -- heartbeat. Messages wait only on agents that acted recently; existing cards start from
    -- their last card change.
    ALTER TABLE agent ADD COLUMN last_call_at TEXT;
    UPDATE agent SET last_call_at = updated_at;
    `,
    `
    -- A message to the whole room is a post on its sender's board: nobody receives it, and the
    -- sender may rewrite it; when it was last rewritten. Bridges older than this step stored some
    -- room-wide messages as direct ones without a recipient.
    ALTER TABLE message ADD COLUMN edited_at TEXT;
    UPDATE message SET recipient_scope = 'all' WHERE recipient_scope = 'direct' AND recipient_agent_id IS NULL;
    DELETE FROM message_receipt WHERE message_id IN (SELECT id FROM message WHERE recipient_scope = 'all');
    `,
    `
    -- The last message number handed out, so a deleted number is never given again: agents refer
    -- to messages by number. Starts from the highest number still kept.
    INSERT INTO meta (key, value) SELECT 'last_message_id', CAST(COALESCE(MAX(id), 0) AS TEXT) FROM message;
    `,
    `
    -- The standing role the user gave an agent, apart from task (what it is doing now).
    ALTER TABLE agent ADD COLUMN role TEXT NOT NULL DEFAULT '';
    `,
    `
    -- When the message's whole text last went out to the recipient in a tool result. It counts as
    -- received at the recipient's next call, through any bridge, or when its turn ends; a bridge
    -- that restarted used to forget it, and the message stayed unread.
    ALTER TABLE message_receipt ADD COLUMN delivered_at TEXT;
    `,
    `
    -- The folder the agent works in now, when it is not the one its session started in. The
    -- started folder (working_directory, workspace_id) stays put, so the card stays with its
    -- project; agents that joined again from a subfolder's repository used to move to it.
    ALTER TABLE agent ADD COLUMN current_directory TEXT;
    -- The concos version of the MCP bridge that last joined or kept the card alive, so the board
    -- can point at sessions still running an older concos after an upgrade. Null until a bridge
    -- from this version on touches the card.
    ALTER TABLE agent ADD COLUMN concos_version TEXT;
    `,
    `
    -- Last change to card content, apart from status, editing and activity.
    ALTER TABLE agent ADD COLUMN content_changed_seq INTEGER NOT NULL DEFAULT 0;
    UPDATE agent SET content_changed_seq = changed_seq WHERE content_changed_seq = 0;

    -- Full card content actually delivered to each viewer; a room cursor is not this record.
    CREATE TABLE card_delivery (
        viewer_agent_id  TEXT    NOT NULL,
        agent_id         TEXT    NOT NULL,
        content_seq      INTEGER NOT NULL,

        CONSTRAINT pk_card_delivery PRIMARY KEY (viewer_agent_id, agent_id),
        CONSTRAINT fk_card_delivery_viewer_agent_id
            FOREIGN KEY (viewer_agent_id) REFERENCES agent (id) ON DELETE RESTRICT,
        CONSTRAINT fk_card_delivery_agent_id
            FOREIGN KEY (agent_id) REFERENCES agent (id) ON DELETE RESTRICT
    );

    CREATE INDEX idx_card_delivery_agent_id ON card_delivery (agent_id);

    -- Bridges already open before migration keep writing schema-12 statements. Track those
    -- writes too; their version string is not a reliable signal of content tracking support.
    CREATE TRIGGER trg_agent_content_insert AFTER INSERT ON agent
    BEGIN
        UPDATE agent SET content_changed_seq = NEW.changed_seq WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_agent_content_update
    AFTER UPDATE OF display_name, client, workspace_id, working_directory, role, task, summary, next_step, blocker, reference_list ON agent
    WHEN NEW.display_name IS NOT OLD.display_name OR NEW.client IS NOT OLD.client
        OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.working_directory IS NOT OLD.working_directory
        OR NEW.role IS NOT OLD.role OR NEW.task IS NOT OLD.task OR NEW.summary IS NOT OLD.summary
        OR NEW.next_step IS NOT OLD.next_step OR NEW.blocker IS NOT OLD.blocker OR NEW.reference_list IS NOT OLD.reference_list
    BEGIN
        UPDATE agent SET content_changed_seq = NEW.changed_seq WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_checkpoint_content_insert AFTER INSERT ON checkpoint
    BEGIN
        UPDATE agent SET content_changed_seq = changed_seq WHERE id = NEW.agent_id;
    END;

    -- Merging moves checkpoints before updating the surviving card's sequence.
    CREATE TRIGGER trg_checkpoint_card_delivery_move AFTER UPDATE OF agent_id ON checkpoint
    WHEN NEW.agent_id IS NOT OLD.agent_id
    BEGIN
        DELETE FROM card_delivery WHERE agent_id IN (OLD.agent_id, NEW.agent_id);
    END;

    -- Only join/merge writes these session identity columns, including when values stay equal.
    CREATE TRIGGER trg_agent_card_delivery_resume AFTER UPDATE OF client, working_directory ON agent
    BEGIN
        DELETE FROM card_delivery WHERE viewer_agent_id = NEW.id;
        UPDATE agent SET delivered_seq = 0 WHERE id = NEW.id;
    END;

    CREATE TRIGGER trg_agent_card_delivery_delete BEFORE DELETE ON agent
    BEGIN
        DELETE FROM card_delivery WHERE viewer_agent_id = OLD.id OR agent_id = OLD.id;
    END;
    `,
    `
    -- Recent folders come only from file-edited hooks; they never advance card delivery.
    ALTER TABLE agent ADD COLUMN recent_folder_list TEXT NOT NULL DEFAULT '[]';

    -- Already-open older bridges/hooks also end sessions and leave without naming this column.
    CREATE TRIGGER trg_agent_recent_folders_end AFTER UPDATE OF disconnected_at, left_at ON agent
    WHEN (NEW.disconnected_at IS NOT NULL OR NEW.left_at IS NOT NULL) AND NEW.recent_folder_list <> '[]'
    BEGIN
        UPDATE agent SET recent_folder_list = '[]' WHERE id = NEW.id;
    END;
    `,
];
