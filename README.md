# rpiv-todo

> [!CAUTION]
> ## This repository has moved to [`juicesharp/rpiv-mono`](https://github.com/juicesharp/rpiv-mono)
>
> This package now lives at **[`packages/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)** inside the monorepo.
>
> - **npm:** still published as `@juicesharp/rpiv-todo` — no install change.
> - **Issues / PRs:** open them on [`rpiv-mono`](https://github.com/juicesharp/rpiv-mono/issues).
> - **This repo is read-only / archived.**

Pi extension that registers the `todo` tool, `/todos` slash command, and a
persistent TodoOverlay widget above the editor. Replaces Claude Code's
TaskCreate/TaskUpdate tool family.

![Todo overlay widget above the Pi editor](https://raw.githubusercontent.com/juicesharp/rpiv-todo/main/docs/overlay.jpg)

## Installation

    pi install npm:@juicesharp/rpiv-todo

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
