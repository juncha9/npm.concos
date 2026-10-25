# Changelog

All notable changes to this project will be documented in this file.

---

## [0.1.6] - 2026-10-25

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
- 0.1.4 was unpublished from npm the day it came out, and 0.1.5 was a release commit in the repository that was never published.

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
