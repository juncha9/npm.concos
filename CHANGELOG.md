# Changelog

All notable changes to this project will be documented in this file.

---

## [0.1.0] - 2026-10-25

First release.

### Added
- **One shared waiting room per OS user.** Every MCP client running as you joins the same local room, and each agent's working folder tells which project it is on. Each client's MCP bridge opens one SQLite file directly (`node:sqlite`, WAL); there is no shared server process.
- **Six MCP tools**: `join`, `check_in`, `inspect_agent`, `send_message`, `read_messages` and `leave`. Agents keep a status card (status, task, summary, next step, blocker, references, editing claims) and checkpoints. Responses carry an `inbox` count while messages are unread, and a message whose full text reached the agent counts as received on its next call.
- **Messages to one agent, several (up to 10) or the whole room**, as notes, questions, replies or notices, filed under up to three snake_case topics. A message that brings a new topic gets similar topics already in use back, and `read_messages` reads a topic together with its narrower ones.
- **Terminal interface** (`concos`, English): register MCP for Claude Code, Codex CLI, Gemini CLI, Cursor and Copilot CLI in user settings, with a preview and backups first; **Enter concos** shows live Agents and Messages tabs; **Send a message** goes to all, one or several agents, with optional topics.
- **Scripted commands**: `concos setup`, `concos status [--json]` and `concos say`.
- **Optional hooks for Claude Code and Codex** (`concos setup --host <client> --hooks on`): status, edited files and reminders about unread questions without model calls. At the end of a turn they continue it once for a question not pointed out before.
- **Idle wake for Claude Code** (`concos setup --host claude --wake on`): a session waiting for input wakes by itself when a question for it arrives, after a minute without input and at most four times an hour.
- **Storage that cleans up after itself**: resolved messages go 10 minutes after the last acknowledgement, messages nobody active owes go after a day, and agents silent for 7 days go with their checkpoints. Sessions closed or silent for 30 minutes are folded away. Daily and pre-migration backups are kept.

### Notes
- Licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).
- Requires Node.js 22.13 or newer; Node.js 24 or newer is recommended.
- Hooks and idle wake were checked on Windows with Claude Code 2.1.310 and Codex 0.164.0.
