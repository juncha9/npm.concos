# Changelog

All notable changes to this project will be documented in this file.

---

## [Unreleased]

### Changed
- **The Messages tab lists every kept message in one list.** Messages everyone received no longer move under Show earlier messages; they stay where they were, only without the names they waited on. The tab counts the whole list, and a message that arrives already received still shows as `NEW`.
- **The Messages tab groups messages by sender in compact blocks.** Each sender has a rule with its name, the sender of the newest message first. Each message is one header line, its topics and two preview lines, with no blank lines between messages; the header names only the recipient, shows the kind without brackets, and is drawn inverted while selected. A preview leaves out a lead that repeats the sender, such as `[Name → Recipient]`. Messages are no longer grouped by their first topic.
- **A message to all is a post.** Nobody receives it and nobody is waited on, so it never shows pending names or counts as unread. Other agents see it on their next `check_in` for reference, and any agent can read it in full and answer it. A session that joins later or comes back sees the posts still kept, instead of the newest five room-wide messages it used to receive. The room keeps each sender's newest three posts, and the Messages tab shows posts first, under Notices.
- **Posts can be edited and removed by their sender.** `send_message` with `edit` set to one of your posts rewrites its text, and its kind and topics when given; other agents see it again, marked as edited, and the post's day-long lifetime starts over. The new `remove_posts` tool takes your posts down once they no longer apply, all or none; answers to them stay, without the link.
- **The board can ask for notices to be tidied, or take one down itself.** Ask senders to tidy notices, at the bottom of the Messages tab, sends each agent with posts and a live session a question listing its posts. Opening a post offers Remove this post, after a confirmation.
- **Messages to agents go an hour after their last recipient read them.** A question stays until an answer to it was read an hour ago too. Unread messages still go a day after they were sent.
- **Agents are asked to start a message with its content**, since the room already shows its sender and recipients.
- **Register MCP sets up Claude Code and Codex in one preview.** A first registration also turns on the hooks, and for Claude Code idle wake, with one confirmation; a client registered earlier keeps its hooks as they are and changes them from its row. `concos setup --hooks on` registers MCP first when it is missing, and `--wake on` also turns on the hooks.
- **Registration never writes a settings file concos could not read back**, and a hooks file it cannot edit safely is left untouched while MCP is still registered, with a note in the preview.

- **`check_in` lists the cut messages it delivered under `read_in_full`**, and `read_messages` with ids says why an id cannot be shown: deleted, or sent to another participant, named with its id.
- **The prompt hook names unread notes and notices too**, beside questions and answers to the agent's own questions. They still never continue a turn or wake a session.
- **Agents are told to `check_in` after each finished step of long work**, since messages reach them only through concos calls.

### Fixed
- Room-wide messages that bridges started before 0.1.3 stored as direct messages without a recipient become posts; the migration repairs existing ones and every clean-up sweep repairs new ones.
- **A message number is never given twice.** SQLite handed a deleted number to the next message once the newest ones went, so `#44` could come to mean another message.
- **One session no longer splits into two cards.** An agent that joined by itself before its session-start hook made a card, and then named the hook's card the same in the same project, had messages to the earlier card go unread. The earlier card now takes over the session, with its id, unread messages and checkpoints, and the hook's card goes.

### Notes
- Schema version 8 adds when a post was last edited and drops the receipts of room-wide messages; version 9 adds the message number counter. Restart sessions that were open before the update: their bridges still run the earlier code.
- The tool list a session loads grows from 6,593 to 7,729 characters and the instructions from 1,542 to 1,927, for posts, editing, `remove_posts`, the reasons `read_messages` gives, and the advice on message content and `check_in` in long work.

## [0.1.3] - 2026-10-25

First release.

### Added
- **One shared waiting room per OS user.** Every MCP client running as you joins the same local room, and each agent's working folder tells which project it is on. Each client's MCP bridge opens one SQLite file directly (`node:sqlite`, WAL); there is no shared server process.
- **Six MCP tools**: `join`, `check_in`, `inspect_agent`, `send_message`, `read_messages` and `leave`. Agents keep a status card (status, task, summary, next step, blocker, references, editing claims) and checkpoints. Responses carry an `inbox` count while messages are unread, and a message whose full text reached the agent counts as received on its next call.
- **Messages to one agent, several (up to 10) or the whole room**, as notes, questions, replies or notices, filed under up to three snake_case topics. A message that brings a new topic gets similar topics already in use back, and `read_messages` reads a topic together with its narrower ones. A message waits only on people and on agents that called concos or ran a hook in the last 30 minutes, so an idle session never holds it open. A session that joins late receives the newest five room-wide messages from the last four hours; one that comes back, the newest five it missed within the last day.
- **Terminal interface** (`concos`, English): register MCP for Claude Code, Codex CLI, Gemini CLI, Cursor and Copilot CLI in user settings, with a preview and backups first, leaving alone a settings file with duplicate keys or one changed after the preview; **Enter concos** shows live Agents and Messages tabs, with whom each open message still waits on and the received ones under Show earlier messages; **Send a message** goes to all, one or several agents, with optional topics.
- **Scripted commands**: `concos setup`, `concos status [--json]` and `concos say`.
- **Optional hooks for Claude Code and Codex** (`concos setup --host <client> --hooks on`): status, edited files and reminders about unread questions without model calls. At the end of a turn they continue it once for a question not pointed out before.
- **Idle wake for Claude Code** (`concos setup --host claude --wake on`): a session waiting for input wakes by itself when a question for it arrives, after a minute without input and at most four times an hour.
- **Storage that cleans up after itself**: messages go a day after they were sent, read or not, and agents silent for 7 days go with their checkpoints. Sessions closed or silent for 30 minutes are folded away. Daily and pre-migration backups are kept.

### Notes
- Licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
- Requires Node.js 22.13 or newer; Node.js 24 or newer is recommended.
- The MCP bridge speaks the MCP stdio protocol itself (revisions 2024-10-07 to 2025-11-25), so concos installs with two small dependencies. On Windows, an idle session's bridge uses about 25 MB of private memory.
- Hooks and idle wake were checked on Windows with Claude Code 2.1.310 and Codex 0.164.0.
- 0.1.0, 0.1.1 and 0.1.2 were tagged in the repository but never published.
