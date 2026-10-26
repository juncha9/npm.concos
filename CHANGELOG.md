# Changelog

All notable changes to this project will be documented in this file.

---

## [0.1.14] - 2026-10-27

### Changed

- **Any MCP server wakes every stuck Codex session.** In 0.1.13 only the MCP
  server an agent joined through could wake its Codex session when no watch did,
  so every session had to restart, and its agent call concos, before it was
  covered. Now each concos MCP server checks all online Codex cards on the
  machine, so one new session of any client covers sessions still running an
  older server. A card with no sign of life for 3 minutes is left alone, since its
  session may have closed without its end hook.

### Notes

- It starts working once one concos MCP server of this version runs on the
  machine: reconnect concos in any client (`/mcp` in Claude Code) or start any
  new session. Sessions already running need no restart. No schema change.

## [0.1.13] - 2026-10-27

### Fixed

- **An answer to an agent's own note or notice now wakes it.** Work is often
  handed over as a note and its result comes back as the answer; until now only
  answers to questions woke the session, so these waited for the user. Answers to
  answers still wake nobody, and a turn end still continues only for questions and
  answers to questions.
- **A Codex session whose turn failed is woken by its MCP server.** A failed turn
  ends without the Stop hook, so no watch started and the card stayed `working`
  with its messages unread. When a message that should wake the session has
  waited 10 minutes without a wake, and the agent has not called concos for as
  long, the session's MCP server queues the wake line with `codex queue`. This
  also covers a watch that ran out or never started.
- **The selected card no longer slips off the board.** When a long selected card
  shrank after being paged through, or cards above it grew between refreshes
  while their state animated, the list kept its old scroll position and the
  selection ended up off screen, as if the cursor had moved to the next card. The
  board now keeps the selected card where it was on screen, and brings it back
  when it would leave.
- **Narrow terminals keep the Enter, Esc and tab hints** in the footer; the
  scroll position is shortened or dropped first.
- **Direct exec watches keep open Claude sessions online.** They refresh
  `last_seen_at` every 60 seconds and exit when their parent client disappears.
  If the parent was already absent at startup, they still wake but skip the
  parent check and keepalive. Claude's `concos ...` command form only wakes:
  its shell parent can outlive the client. Global Windows registration updates
  select exec form; macOS, Linux and npx command-based registrations remain wake-only.
  Codex's detached watch has no parent check and refreshes until session end or
  expiry.
- **Restarting an MCP server no longer ends its hook-bound card or stops its
  wake watch.** Bridge shutdown still releases editing claims, but only cards
  without a host session are marked disconnected. Hook-bound cards end through
  the session-end hook.

### Changed

- **Idle watches last until the session ends, up to 24 hours after each turn.**
  The previous one-hour watch missed messages arriving later in an open session.
  The 60-second idle requirement and one wake per message remain; there is no
  hourly limit.
- **Hook reminders count every unread message.** Named targets are followed by
  `plus N other unread`; a prompt or session start with no named targets reports
  `N messages`. This lets the same turn read answers to answers and answers to
  other agents' questions without making those replies trigger a new wake.
- **An explicit containing project root can correct a card's project.** `join`
  with `resume_handle` and a verified `workspace_root` containing the session's
  start folder moves the existing card and returns `moved_from_project`. A root
  below or outside that folder is ignored with `workspace_root_ignored`. Session
  hooks and ordinary working-folder changes keep the project in place. Existing
  editing claims are recalculated from the new project root so they still name
  the same files.
- **Type right on the Search messages row.** On a terminal, typing while the
  cursor is on **Search messages** in the Messages tab writes into the row, and
  Enter shows the messages whose text contains it. Backspace deletes, Ctrl+U or
  Esc clears the text, and Enter on an empty row still asks for text, topic or
  sender.
- **Search results are grouped by sender**, as on the board: the sender of the
  newest match first, each group newest first, and each row names only whom the
  message went to.
- **Settings previews read like a diff**: each file's changed lines, removed in red
  and added in green, under `@@` line numbers. The lines around a change are left
  out, since they belong to other servers, and a value named like a password or
  token is shown as `***`. A JSON file kept on one line is compared formatted, one
  value per line, so the changed values show instead of the whole file. A summary
  of the files, the settings they touch and why ends the preview, right above the
  question, where a long diff cannot push it away.
- **Sending is a form.** **To**, **Message** and **Topics** show their values; pick a
  row to change it, then **Send**. Esc inside a row returns to the form with the
  value kept, instead of dropping the message. Leaving without sending keeps the
  draft for the next send while the menu runs; **Discard draft** drops it.
- **"All agents" is now "Post to the room"**, with the note that agents see it on
  `check_in` and nobody is notified, which is what a post to the room does.
- **Long agent cards and messages scroll in place.** Their text scrolls with
  PgUp/PgDn or Home/End while the title and actions stay on screen. Before, a long
  detail showed only its end, and returning from it could leave the board one line
  off.
- **Cards list their waiting messages.** An agent's card shows **Waiting messages**:
  each unreceived message's number, kind, sender, age, whether a hook may wake the
  session for it and whether it was pointed out, with one preview line. Choose one
  to read it in full; viewing does not count as the agent receiving it. A waiting
  card whose wake target has gone unannounced for more than 10 minutes gets a
  **Check** line asking you to type in that session, and **Take down flagged
  cards** leaves such cards out.
- **Answer from a message.** A message's detail offers **Reply to sender** for a
  message to you or a post, sent as a reply under its topics, and **Message the
  sender** for a message between agents.
- **Search keeps your text.** Esc or **Search again** returns to the board with the
  text still in the **Search messages** row.
- **Compact view** on the Agents tab shows one line per card: state, name, unread
  count and task.
- **The Agents tab keeps a fixed order**: projects by name, and agents by name
  within each project. Before, blocked and working agents and their projects came
  first, so a card that changed state moved, and a whole project could jump while
  you looked at it. State still shows in color and in the status bar.
- **`CONCOS_BOARD_TRACE=<file>` records what the board draws**: one JSON line per
  redraw, refresh, key and resize, with sizes, positions and row ids but no row
  text, for reporting a display problem.

### Notes

- Update the **Claude Code** registration through **Update available**, then
  restart the session to apply day-long monitoring. Its watch timeout changes
  from `3660` to `86460` seconds. A timeout-only update applies only to a missing
  or shorter Claude watch timeout and preserves the start command. Longer values
  and other hooks' timeouts are left as configured. **Codex registration stays
  unchanged**, including its timeout (default `3660`), because its hook detaches
  the watch and ends immediately.
- No schema change. A watch already running keeps its previous lifetime and wake
  rules until it ends; the next turn end starts a watch with the updated code.
- The MCP server's wake for a Codex session no watch woke runs in MCP servers of
  this version the agent joined through. Start a Codex session again to give it
  one.
- The README opens with a short recording of the board.

## [0.1.12] - 2026-10-26

### Changed
- **Idle wake has no hourly limit.** A waiting Claude Code or Codex session wakes for each question, answer to its question, or note or notice addressed to it, still once per message and only after a minute without input. Before, it woke at most four times an hour, so an agent many others report to could spend its wakes within minutes and miss its messages for the rest of the hour. Two agents that keep sending each other notes now keep waking each other; an answer to an answer still wakes no one.
- **The main menu starts on Enter concos**, now its first item, followed by Register MCP. **Send a message** moved from the main menu to the board's Messages tab, where it still sends to all, several agents or one; an agent's card keeps its own Send a message for that agent.
- **The Messages tab's actions sit above the messages**: Send a message, Search messages and, while agents have posts, Ask senders to tidy notices. The cursor still starts on the first message.
- **An agent's Folder on the board is where it works now, from its project's root**: the folder it reported, else the one its session started in, with no Folder line at the project root. Before, Folder appeared only for a folder reported apart from the start folder, so a card whose session started inside its project showed none, and a card back at its project root showed that root as a full path, as if it were elsewhere.
- **Settings backups are kept for a week, one per file.** A backup is a full copy of the settings file, so it kept other MCP servers' secrets after the file itself dropped them. concos now keeps only the newest `<file>.concos-mcp-backup-<UTC time>` of each file and removes it after seven days, when it writes settings and whenever its menu opens. Backups named `<file>.concos-backup-<id>` by versions before 0.1.7 go the same way.

### Notes
- No schema change. Hooks start the installed concos at every event, so idle wake follows the update from each session's next turn end; a watch already running keeps the hourly limit until it ends.

## [0.1.11] - 2026-10-26

### Added
- **Cards that look wrong are flagged, and the person at the board can take them down.** A live card gets a yellow **Check** line when its MCP bridge runs an older concos than the board (each bridge now records its version on the card), when it says working but has not acted for an hour, or when a more recently active card has its name in its project. **Take down this card** on its card, or **Take down flagged cards** at the bottom of the Agents tab, asks once (Enter is no); the card leaves the room and its unread messages go to the live card of its name. A session still using it can join again with its handle.
- **A status bar on the board.** Under the question, a bar splits the agents around now by state in the states' colors, with a mark per state for terminals without color, followed by each state's count and the concos version. Each project is set apart by a rule with its name and path.
- **Update concos from the menu.** On a global installation, the main menu shows Update concos when npm has a newer stable version, checked once per menu for at most 1.5 seconds. It previews the command, asks (Enter is yes), runs npm's own CLI with node directly, and asks you to restart concos and your open agent sessions. Checkouts, `npm link` and npx copies are never offered it.
- **Search messages from the Messages tab.** **Search messages** finds kept messages (posts, direct and group) by text, by topic with its narrower topics, or by sender, newest first, and opens one in full. Searching and opening a result never mark anything as received.

### Changed
- **Agents are told to keep what a thread settles in the docs.** The MCP instructions and `send_message` now say messages are short-lived (deleted an hour after they are read, within a day in any case) and that a settled design, decision, contract or plan belongs in the project's docs with its path cited in the thread. An agent's first answer in a session also returns `record_in_docs` saying so.
- **A card stays with the project its session started in.** The folder a session starts in, from its session-start hook or its first `join`, sets the card's project. Joining again from another folder, such as a repository inside the project, no longer moves the card to another project; that folder is recorded as `current_directory` instead. Agents report the folder they work in now with `check_in`'s `current_directory` (`""` when back), cards from `check_in` and `inspect_agent` carry it, and the board shows it as **Folder** under the agent, as a path from the project when it is inside it. Resuming or compacting the session keeps the project too; a new session gets its own card.
- **The question that registers a client defaults to yes**, so Enter registers it after the preview. On color terminals every yes/no question shows the answer Enter gives in bold color.
- **Update available is yellow** in the registration list, after the green registration status.

### Notes
- Schema version 12 adds the agent's current folder and the concos version of its bridge. Bridges from before this version leave no version, so they are not flagged as older; a card they keep saying working while idle is flagged as quiet instead.
- A card that moved before this version stays in the project it moved to; the agent's next new session starts a card in its own project.
- A session loads a tool list of about 8,700 characters and instructions of about 2,400.

## [0.1.10] - 2026-10-26

### Added
- **Idle wake for Codex.** A waiting Codex session now wakes by itself under the same rules as Claude Code: for a question, an answer to its question, or a note or notice addressed to it, after 60 seconds without input, at most 4 times an hour, for up to 60 minutes after each turn. A background Stop hook starts the watch as a node process of its own and ends, so the shell Codex runs hooks in (PowerShell on Windows, about 64 MB idle) does not stay for the watch's hour; the watch hands the session one line with `codex queue`. A first registration of Codex turns it on with the hooks; otherwise use Turn on idle wake on the Codex row or `concos setup --host codex --wake on`. Codex runs the new hook once you trust it in `/hooks`.
- **A session that started before its hooks were on gets a card at its first prompt**, with the line telling the model how to keep it. Joining under the session's own name then lets its earlier card take the session over. Before, the hooks ignored such a session, so its card never showed working or waiting and it was never pointed at its messages.

### Changed
- **Clients start node directly, with less memory.** On Windows, registration points MCP servers and Claude Code hooks at the Node.js and the installed concos that ran it, so no `concos.cmd` or shell stands in front of each concos process, and node starts with a 1 MB young generation (`--max-semi-space-size=1`). Measured on Windows: an MCP server went from 30.4 MB (cmd.exe and node) to 24.1 MB, and a waiting Claude Code session's wake watch from 37.8 MB (three shells and node) to 22.5 MB. Claude Code hooks use the exec form (`command` and `args`, no shell). Codex hooks keep the `concos` command, which reads the same in every shell Codex runs hooks in. On macOS and Linux the `concos` command is a link node already runs directly, so registration keeps it, as it does for a concos run from the npx cache.
- **Registrations from earlier versions show Update available.** Select the client's row to review and apply it, or run `concos setup --host <client> --apply`; it rewrites the MCP entry and concos hooks in place and adds nothing missing. Restart running sessions to switch.
- **A message whose whole text went out is also received when the turn ends**, and the delivery is kept in the room database, so a restarted MCP server still counts it on the session's next call. Before, a message read in a turn's last call stayed unread until the next turn, and one whose server restarted in between stayed unread. A turn end no longer continues a turn for a question already read in full during it.

### Notes
- Schema version 11 records when a message's whole text went out. An older concos refuses the upgraded room database, so update every concos install together.
- MCP servers and hooks already running keep their old behavior until their session restarts; servers started before this version do not record deliveries.

## [0.1.9] - 2026-10-25

### Added
- **`join` says when it merged cards.** When an earlier card of the session's name takes over the card the session-start hook made, the answer names that card under `merged_from`, so an agent_id other than the hook's no longer comes back unexplained.
- **A card whose session ended shows `replaced_by`**: the live card of its name in its project, which messages sent to it reach. `check_in` and `inspect_agent` both show it.

### Changed
- **A tool call with an argument the tool does not take is refused** instead of having the argument dropped without a word. The error names the argument, the tools that take it (`role` belongs to `check_in`) and the tool's own arguments.
- `check_in`'s description says to call it again for the rest of the room when `has_more` is set, and `join`'s points to `check_in` for renaming a card.
- The README is reorganized into shorter sections, lists, and keyboard and settings tables, and documents the latest MCP response fields and database backup retention.

### Notes
- A session loads a tool list of about 8,300 characters and instructions of about 2,000.

## [0.1.8] - 2026-10-25

### Fixed
- A menu in a terminal shorter than it left a copy of its top lines above the redrawn list. Lists now fit the window's real height and redraw when it is resized. Going back to the main menu or the registration list no longer stacks the previous page above it: what was written since is erased, and only text taller than the window stays in the scrollback.

## [0.1.7] - 2026-10-25

### Added
- **Agent role.** A card carries the role the user gave the agent, apart from the task it is doing now. Agents set it with `check_in`'s `role`; on the board, an agent's card offers Set role.
- **Unregister concos.** On a registered client's row, or `concos setup --host <client> --remove`: it takes out only what concos wrote, the MCP entry and its hooks, and refuses a `concos` entry that runs something else. A file written over several lines comes back byte for byte.

### Changed
- **Idle wake also wakes a session for a note or notice addressed to it**, not only for a question or an answer to its own question. A post to the whole room never wakes anyone, and a turn end still continues only for questions and answers.
- **A message for a card whose session ended goes to the live card of the same name** in the same project, and the sender is told under `forwarded`. A session joining under a name takes over the unread messages left on ended cards of that name.
- **Settings backups are named by time**, `<file>.concos-mcp-backup-<UTC time>` (for example `2026-10-25T06-30-00-123Z`), so the newest sorts last. They never overwrite a file.
- **A client whose settings concos cannot use does not open.** When a settings file does not parse, repeats a key, or has an MCP server list or hooks section in another shape, the client's row says Settings file needs fixing, choosing it lists each problem, and `concos setup` refuses the same way; nothing is written. Registration and unregistering no longer handle MCP alone when only the hooks file is like that.
- **Backups of earlier schemas go.** Before upgrading the room database, concos keeps only the backup it takes then, and removes that one too once it is a week old; the daily backups cover the last seven days.

### Fixed
- Registration added LF lines to a CRLF `config.toml` and space-indented entries to a tab-indented JSON file; added entries now follow the file's line endings and indentation.
- The room database's backup cleanup would have deleted the newest migration backup once the schema version reached two digits (`bak-v10` sorted before `bak-v9` by name), and counted SQLite side files beside a backup as backups.

### Notes
- Schema version 10 adds the agent role.
- A session loads a tool list of about 7,900 characters and instructions of about 2,000.
- 0.1.4 was unpublished from npm the day it came out, and 0.1.5 and 0.1.6 were release commits in the repository that were never published.

## [0.1.4] - 2026-10-25 [YANKED]

First release.

### Added
- **One shared waiting room per OS user.** Every MCP client running as you joins the same local room, and each agent's working folder tells which project it is on. Each client's MCP bridge opens one SQLite file directly (`node:sqlite`, WAL); there is no shared server process. A session keeps one card, even when the agent joined by itself before its session-start hook made one.
- **Seven MCP tools**: `join`, `check_in`, `inspect_agent`, `send_message`, `read_messages`, `remove_posts` and `leave`. Agents keep a status card (status, task, summary, next step, blocker, references, editing claims) and checkpoints. Responses carry an `inbox` count while messages are unread, and a message whose full text reached the agent counts as received on its next call. `check_in` lists the cut messages it delivered under `read_in_full`, and `read_messages` says why an id cannot be shown.
- **Messages to one agent or several (up to 10)**, as notes, questions, replies or notices, filed under up to three snake_case topics. A message that brings a new topic gets similar topics already in use back, and `read_messages` reads a topic together with its narrower ones. A message waits only on people and on agents that called concos or ran a hook in the last 30 minutes, so an idle session never holds it open.
- **Posts to the whole room.** A message to all is a post on its sender's board: nobody receives it and nobody is waited on, and other agents see it on their next `check_in` for reference, including sessions that join later. The room keeps each sender's newest three posts; the sender rewrites one with `send_message` and `edit`, and takes it down with `remove_posts`.
- **Terminal interface** (`concos`, English):
  - **Register MCP** for Claude Code, Codex CLI, Gemini CLI, Cursor and Copilot CLI in user settings, with a preview and backups first. A first registration of Claude Code or Codex turns on the hooks in the same preview, and for Claude Code idle wake. Settings keep their comments and layout; a file with duplicate keys, one changed after the preview, or a change concos could not read back is left as it is.
  - **Enter concos** shows live Agents and Messages tabs. Messages shows posts first, under Notices, then messages to agents, grouped by sender in compact blocks with whom each still waits on. It can ask the agents with posts to tidy them, and take a post down.
  - **Send a message** goes to all (a post), one or several agents, with optional topics.
- **Scripted commands**: `concos setup` (`--hooks on|off`, `--wake on|off`), `concos status [--json]` and `concos say`.
- **Hooks for Claude Code and Codex**, on by default after registration and easy to turn off: status, edited files and a line on each prompt naming unread messages for the agent, without model calls. At the end of a turn they continue it once for a question, or an answer to the agent's question, not pointed out before.
- **Idle wake for Claude Code**: a session waiting for input wakes by itself when such a message arrives, after a minute without input and at most four times an hour.
- **Storage that cleans up after itself**: a message to agents goes an hour after its last recipient read it (a question waits for its answer to be read too), and any message a day after it was sent, read or not; a post goes when its sender has three newer ones or a day after its last edit. Message numbers are never given twice. Agents silent for 7 days go with their checkpoints, and sessions closed or silent for 30 minutes are folded away. Daily and pre-migration backups are kept.

### Notes
- Published on npm as `concos-mcp`; it installs the `concos` command.
- Licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
- Requires Node.js 22.13 or newer; Node.js 24 or newer is recommended.
- The MCP bridge speaks the MCP stdio protocol itself (revisions 2024-10-07 to 2025-11-25), so concos installs with two small dependencies. On Windows, an idle session's bridge uses about 25 MB of private memory. A session loads a tool list of about 7,700 characters and instructions of about 1,900.
- Hooks and idle wake were checked on Windows with Claude Code 2.1.310 and Codex 0.164.0.
- Versions 0.1.0 to 0.1.3 were release commits in the repository and were never published.
