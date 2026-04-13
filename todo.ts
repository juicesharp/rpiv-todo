/**
 * todo tool + /todos command — Claude-Code-parity Task management.
 *
 * State lives in this module and persists via the tool's AgentToolResult.details
 * envelope. reconstructTodoState walks ctx.sessionManager.getBranch() and restores
 * the last snapshot; the pure applyTaskMutation reducer is the single source of
 * truth for invariants — state machine transitions, blockedBy cycle checks,
 * dangling-reference rejection. Tool name is deliberately "todo" (not
 * TaskCreate/etc.) to preserve the permissions entry at
 * templates/pi-permissions.jsonc:26.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
	id: number;
	subject: string;
	description?: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
}

export interface TaskDetails {
	action: TaskAction;
	params: Record<string, unknown>;
	tasks: Task[];
	nextId: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["deleted"]),
	deleted: new Set(),
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let tasks: Task[] = [];
let nextId = 1;

export function getTodos(): readonly Task[] {
	return tasks;
}

// ---------------------------------------------------------------------------
// Pure helpers — no state mutation, no I/O
// ---------------------------------------------------------------------------

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}

export function detectCycle(
	taskList: readonly Task[],
	taskId: number,
	newBlockedBy: readonly number[],
): boolean {
	const edges = new Map<number, number[]>();
	for (const t of taskList) {
		if (t.id === taskId) {
			const merged = new Set([...(t.blockedBy ?? []), ...newBlockedBy]);
			edges.set(t.id, [...merged]);
		} else {
			edges.set(t.id, t.blockedBy ? [...t.blockedBy] : []);
		}
	}

	const visiting = new Set<number>();
	const visited = new Set<number>();
	const hasCycleFrom = (node: number): boolean => {
		if (visiting.has(node)) return true;
		if (visited.has(node)) return false;
		visiting.add(node);
		for (const nb of edges.get(node) ?? []) {
			if (hasCycleFrom(nb)) return true;
		}
		visiting.delete(node);
		visited.add(node);
		return false;
	};

	for (const node of edges.keys()) {
		if (hasCycleFrom(node)) return true;
	}
	return false;
}

export function deriveBlocks(taskList: readonly Task[]): Map<number, number[]> {
	const blocks = new Map<number, number[]>();
	for (const t of taskList) {
		for (const dep of t.blockedBy ?? []) {
			const arr = blocks.get(dep) ?? [];
			arr.push(t.id);
			blocks.set(dep, arr);
		}
	}
	return blocks;
}

// ---------------------------------------------------------------------------
// Reducer — pure, single source of truth for invariants
// ---------------------------------------------------------------------------

interface ReducerState {
	tasks: Task[];
	nextId: number;
}

interface ReducerResult {
	state: ReducerState;
	details: TaskDetails;
	content: Array<{ type: "text"; text: string }>;
}

interface TaskMutationParams {
	[key: string]: unknown;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	blockedBy?: number[];
	addBlockedBy?: number[];
	removeBlockedBy?: number[];
	owner?: string;
	metadata?: Record<string, unknown>;
	id?: number;
	includeDeleted?: boolean;
}

function errorResult(
	state: ReducerState,
	action: TaskAction,
	params: TaskMutationParams,
	error: string,
): ReducerResult {
	return {
		state,
		details: {
			action,
			params: params as Record<string, unknown>,
			tasks: state.tasks,
			nextId: state.nextId,
			error,
		},
		content: [{ type: "text", text: `Error: ${error}` }],
	};
}

export function applyTaskMutation(
	state: ReducerState,
	action: TaskAction,
	params: TaskMutationParams,
): ReducerResult {
	switch (action) {
		case "create": {
			if (!params.subject || !params.subject.trim()) {
				return errorResult(state, action, params, "subject required for create");
			}
			if (params.blockedBy && params.blockedBy.length) {
				for (const dep of params.blockedBy) {
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) {
						return errorResult(
							state,
							action,
							params,
							`blockedBy: #${dep} not found`,
						);
					}
					if (depTask.status === "deleted") {
						return errorResult(
							state,
							action,
							params,
							`blockedBy: #${dep} is deleted`,
						);
					}
				}
			}
			const newTask: Task = {
				id: state.nextId,
				subject: params.subject,
				status: "pending",
			};
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.blockedBy && params.blockedBy.length) {
				newTask.blockedBy = [...params.blockedBy];
			}
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };

			const newTasks = [...state.tasks, newTask];
			const newState: ReducerState = { tasks: newTasks, nextId: state.nextId + 1 };
			return {
				state: newState,
				details: {
					action: "create",
					params: params as Record<string, unknown>,
					tasks: newTasks,
					nextId: newState.nextId,
				},
				content: [
					{
						type: "text",
						text: `Created #${newTask.id}: ${newTask.subject} (pending)`,
					},
				],
			};
		}

		case "update": {
			if (params.id === undefined) {
				return errorResult(state, action, params, "id required for update");
			}
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) {
				return errorResult(state, action, params, `#${params.id} not found`);
			}
			const current = state.tasks[idx];

			const hasMutation =
				params.subject !== undefined ||
				params.description !== undefined ||
				params.activeForm !== undefined ||
				params.status !== undefined ||
				params.owner !== undefined ||
				params.metadata !== undefined ||
				(params.addBlockedBy && params.addBlockedBy.length > 0) ||
				(params.removeBlockedBy && params.removeBlockedBy.length > 0);
			if (!hasMutation) {
				return errorResult(
					state,
					action,
					params,
					"update requires at least one mutable field",
				);
			}

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) {
					return errorResult(
						state,
						action,
						params,
						`illegal transition ${current.status} → ${params.status}`,
					);
				}
				newStatus = params.status;
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy && params.removeBlockedBy.length) {
				const toRemove = new Set(params.removeBlockedBy);
				newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
			}
			if (params.addBlockedBy && params.addBlockedBy.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) {
						return errorResult(
							state,
							action,
							params,
							`cannot block #${current.id} on itself`,
						);
					}
					const depTask = state.tasks.find((t) => t.id === dep);
					if (!depTask) {
						return errorResult(
							state,
							action,
							params,
							`addBlockedBy: #${dep} not found`,
						);
					}
					if (depTask.status === "deleted") {
						return errorResult(
							state,
							action,
							params,
							`addBlockedBy: #${dep} is deleted`,
						);
					}
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) {
					return errorResult(
						state,
						action,
						params,
						"addBlockedBy would create a cycle in the blockedBy graph",
					);
				}
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) {
					if (v === null) delete merged[k];
					else merged[k] = v;
				}
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newBlockedBy.length) {
				updated.blockedBy = newBlockedBy;
			} else {
				delete updated.blockedBy;
			}
			if (newMetadata === undefined) {
				delete updated.metadata;
			} else {
				updated.metadata = newMetadata;
			}

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			const transition =
				current.status !== newStatus
					? ` (${current.status} → ${newStatus})`
					: "";
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				details: {
					action: "update",
					params: params as Record<string, unknown>,
					tasks: newTasks,
					nextId: state.nextId,
				},
				content: [
					{ type: "text", text: `Updated #${updated.id}${transition}` },
				],
			};
		}

		case "list": {
			const includeDeleted = params.includeDeleted === true;
			const statusFilter = params.status;
			let view = state.tasks;
			if (!includeDeleted) {
				view = view.filter((t) => t.status !== "deleted");
			}
			if (statusFilter) {
				view = view.filter((t) => t.status === statusFilter);
			}
			const text =
				view.length === 0
					? "No tasks"
					: view
							.map((t) => {
								const block = t.blockedBy?.length
									? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
									: "";
								const form =
									t.status === "in_progress" && t.activeForm
										? ` (${t.activeForm})`
										: "";
								return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
							})
							.join("\n");
			return {
				state,
				details: {
					action: "list",
					params: params as Record<string, unknown>,
					tasks: state.tasks,
					nextId: state.nextId,
				},
				content: [{ type: "text", text }],
			};
		}

		case "get": {
			if (params.id === undefined) {
				return errorResult(state, action, params, "id required for get");
			}
			const task = state.tasks.find((t) => t.id === params.id);
			if (!task) {
				return errorResult(state, action, params, `#${params.id} not found`);
			}
			const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
			const lines = [`#${task.id} [${task.status}] ${task.subject}`];
			if (task.description) lines.push(`  description: ${task.description}`);
			if (task.activeForm) lines.push(`  activeForm: ${task.activeForm}`);
			if (task.blockedBy?.length) {
				lines.push(
					`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`,
				);
			}
			if (blocks.length) {
				lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
			}
			if (task.owner) lines.push(`  owner: ${task.owner}`);
			return {
				state,
				details: {
					action: "get",
					params: params as Record<string, unknown>,
					tasks: state.tasks,
					nextId: state.nextId,
				},
				content: [{ type: "text", text: lines.join("\n") }],
			};
		}

		case "delete": {
			if (params.id === undefined) {
				return errorResult(state, action, params, "id required for delete");
			}
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) {
				return errorResult(state, action, params, `#${params.id} not found`);
			}
			const current = state.tasks[idx];
			if (current.status === "deleted") {
				return errorResult(
					state,
					action,
					params,
					`#${current.id} is already deleted`,
				);
			}
			const updated: Task = { ...current, status: "deleted" };
			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return {
				state: { tasks: newTasks, nextId: state.nextId },
				details: {
					action: "delete",
					params: params as Record<string, unknown>,
					tasks: newTasks,
					nextId: state.nextId,
				},
				content: [
					{ type: "text", text: `Deleted #${updated.id}: ${updated.subject}` },
				],
			};
		}

		case "clear": {
			const count = state.tasks.length;
			return {
				state: { tasks: [], nextId: 1 },
				details: {
					action: "clear",
					params: params as Record<string, unknown>,
					tasks: [],
					nextId: 1,
				},
				content: [{ type: "text", text: `Cleared ${count} tasks` }],
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Persistence — snapshot-based replay with type-guard
// ---------------------------------------------------------------------------

function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

export function reconstructTodoState(ctx: any): void {
	tasks = [];
	nextId = 1;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
		const details: unknown = msg.details;
		if (!isTaskDetails(details)) continue;
		tasks = details.tasks.map((t) => ({ ...t }));
		nextId = details.nextId;
	}
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function formatStatus(status: TaskStatus): string {
	switch (status) {
		case "in_progress": return "in progress";
		case "deleted": return "deleted";
		default: return status;
	}
}

const STATUS_GLYPH: Record<TaskStatus, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	deleted: "⊘",
};

// Mirrors todo-overlay.ts:statusGlyph palette, but uses `muted` for deleted so
// a successful delete is visually distinct from the error branch (which uses
// `error` + `✗`).
const STATUS_COLOR: Record<TaskStatus, "dim" | "warning" | "success" | "muted"> = {
	pending: "dim",
	in_progress: "warning",
	completed: "success",
	deleted: "muted",
};

const ACTION_GLYPH: Record<TaskAction, string> = {
	create: "+",
	update: "→",
	delete: "×",
	get: "›",
	list: "☰",
	clear: "∅",
};

function taskSubject(id: number): string | undefined {
	return tasks.find((t) => t.id === id)?.subject;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(["create", "update", "list", "get", "delete", "clear"] as const),
	subject: Type.Optional(
		Type.String({ description: "Task subject line (required for create)" }),
	),
	description: Type.Optional(
		Type.String({ description: "Long-form task description" }),
	),
	activeForm: Type.Optional(
		Type.String({
			description:
				"Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
		}),
	),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed", "deleted"] as const, {
			description: "Target status (update) or list filter (list)",
		}),
	),
	blockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Initial blockedBy ids (create only)",
		}),
	),
	addBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to add to blockedBy (update only, additive merge)",
		}),
	),
	removeBlockedBy: Type.Optional(
		Type.Array(Type.Number(), {
			description: "Task ids to remove from blockedBy (update only, additive merge)",
		}),
	),
	owner: Type.Optional(
		Type.String({ description: "Agent/owner assigned to this task" }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Arbitrary metadata; pass null value for a key to delete that key on update",
		}),
	),
	id: Type.Optional(
		Type.Number({
			description: "Task id (required for update, get, delete)",
		}),
	),
	includeDeleted: Type.Optional(
		Type.Boolean({
			description:
				"If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
		}),
	),
});

export function registerTodoTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
		promptSnippet: "Manage a Claude-Code-style task list to track multi-step progress",
		promptGuidelines: [
			"Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
			"When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
			"Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
			"Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
			"Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
			"list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
			"Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyTaskMutation(
				{ tasks, nextId },
				params.action,
				params as TaskMutationParams,
			);
			tasks = result.state.tasks;
			nextId = result.state.nextId;
			return {
				content: result.content,
				details: result.details,
			};
		},

		renderCall(args, theme, _context) {
			const glyph = ACTION_GLYPH[args.action] ?? args.action;
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", glyph);

			if (args.action === "create" && args.subject) {
				text += ` ${theme.fg("dim", args.subject)}`;
			} else if (
				(args.action === "update" || args.action === "get" || args.action === "delete") &&
				args.id !== undefined
			) {
				const subject = taskSubject(args.id);
				text += ` ${theme.fg("accent", subject ?? `#${args.id}`)}`;
			} else if (args.action === "list" && args.status) {
				text += ` ${theme.fg("muted", formatStatus(args.status))}`;
			} else if (args.action === "clear") {
				// nothing extra
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme, _context) {
			if (result.isError) {
				return new Text(theme.fg("error", "✗"), 0, 0);
			}
			const details = result.details as TaskDetails | undefined;
			// Only create/update/delete advertise a status; list/get/clear render a
			// plain ✓. This prevents list from rendering the last task's status as
			// if it were the operation's result.
			let status: TaskStatus | undefined;
			if (details) {
				const params = details.params as TaskMutationParams;
				switch (details.action) {
					case "create":
						// New task is the last element of details.tasks.
						status = details.tasks[details.tasks.length - 1]?.status;
						break;
					case "update":
						status =
							params.status ??
							details.tasks.find((t) => t.id === params.id)?.status;
						break;
					case "delete":
						status = details.tasks.find((t) => t.id === params.id)?.status;
						break;
					case "list":
					case "get":
					case "clear":
						break;
				}
			}
			if (status) {
				return new Text(
					theme.fg(STATUS_COLOR[status], `${STATUS_GLYPH[status]} ${formatStatus(status)}`),
					0,
					0,
				);
			}
			return new Text(theme.fg("success", "✓"), 0, 0);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI): void {
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			const visible = tasks.filter((t) => t.status !== "deleted");
			if (visible.length === 0) {
				ctx.ui.notify("No todos yet. Ask the agent to add some!", "info");
				return;
			}

			const pending = visible.filter((t) => t.status === "pending");
			const inProgress = visible.filter((t) => t.status === "in_progress");
			const completed = visible.filter((t) => t.status === "completed");

			const header: string[] = [];
			if (completed.length > 0) {
				header.push(`${completed.length}/${visible.length} completed`);
			}
			if (inProgress.length > 0) {
				header.push(`${inProgress.length} ${formatStatus("in_progress")}`);
			}
			if (pending.length > 0) {
				header.push(`${pending.length} pending`);
			}

			const lines: string[] = [header.join(" · ")];

			const renderTask = (t: Task, glyph: string): string => {
				const form =
					t.status === "in_progress" && t.activeForm
						? ` (${t.activeForm})`
						: "";
				const block = t.blockedBy?.length
					? `    ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
					: "";
				return `  ${glyph} #${t.id} ${t.subject}${form}${block}`;
			};

			if (pending.length > 0) {
				lines.push("── Pending ──");
				for (const t of pending) lines.push(renderTask(t, "○"));
			}
			if (inProgress.length > 0) {
				lines.push("── In Progress ──");
				for (const t of inProgress) lines.push(renderTask(t, "◐"));
			}
			if (completed.length > 0) {
				lines.push("── Completed ──");
				for (const t of completed) lines.push(renderTask(t, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
