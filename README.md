# rpiv-todo

Pi extension that registers the `todo` tool, `/todos` slash command, and a
persistent TodoOverlay widget above the editor. Replaces Claude Code's
TaskCreate/TaskUpdate tool family.

## Installation

    pi install npm:rpiv-todo

Then restart your Pi session.

## Tool

- **`todo`** — create / update / list / get / delete / clear tasks. 4-state
  machine (pending → in_progress → completed, plus deleted tombstone).
  Supports `blockedBy` dependency tracking with cycle detection. Tasks persist
  via branch replay — survive session compact and `/reload`.

## Commands

- **`/todos`** — print the current todo list grouped by status.

## Overlay

The aboveEditor widget auto-renders whenever any non-deleted tasks exist.
12-line collapse threshold; completed tasks drop first on overflow, pending
tasks truncate last. Auto-hides when the list is empty.

## License

MIT
