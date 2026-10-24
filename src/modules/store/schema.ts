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
];
