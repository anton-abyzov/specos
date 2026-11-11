<!-- SW:META template="claude" version="3.1.21" sections="header" -->

<!-- SW:SECTION:header version="3.1.21" -->
@AGENTS.md

# specos: Claude Code notes

Everything shared by every tool is in AGENTS.md, imported above. Only Claude-specific notes belong here.

- Skills: `/sw-increment "title"`, `/sw-do`, `/sw-auto`, `/sw-review`, `/sw-done`, `/sw-handoff`, from `.claude/skills/`, so they load in cloud sessions too. With the `sw` plugin they are also `/sw:do` and so on.
- With the plugin, the SessionStart hook prints a short pickup; run `specweave pickup` for the next task's acceptance criteria.
- Use plan mode before writing a spec for anything bigger than a small fix.
<!-- SW:END:header -->

## Project notes

(Claude-only notes; anything every tool needs goes in AGENTS.md)
