/**
 * Tool-call correctness: choosing the right operation with the right parameters on the first try.
 *
 * Ten points, five items, two points each, graded by exact match on the **first** tool call. The
 * construct is the first attempt, so the briefs end with "Do nothing else", and the grading
 * looks only at the first call the model makes.
 *
 * Every task has a sibling operation that is a plausible mistake rather than a random one:
 * cancelling an order against refunding it, escalating a ticket against closing it, disabling an
 * account against resetting its password, sending a message against archiving one. Getting the
 * resource right and the operation wrong is the failure this category exists to detect.
 *
 * Where a string parameter is graded, the brief quotes the exact value to use. Grading free text
 * by exact match without stating it would test the model's ability to guess the grader.
 */

import type { ApiOperation, ApiState, ItemTemplate, ToolObservation } from "../types.ts";
import type { Rng } from "../rng.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const ok = (output: string): ToolObservation => ({ ok: true, output });
const fail = (output: string): ToolObservation => ({ ok: false, output });

function text(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = args[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function amount(args: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

type Row = Record<string, unknown>;

function table(state: Record<string, unknown>, name: string): Record<string, Row> {
  const existing = state[name];
  if (existing !== null && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, Row>;
  }
  const created: Record<string, Row> = {};
  state[name] = created;
  return created;
}

function list(state: Record<string, unknown>, name: string): unknown[] {
  const existing = state[name];
  if (Array.isArray(existing)) return existing;
  const created: unknown[] = [];
  state[name] = created;
  return created;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * The operations console.
 *
 * Shared by every item in the category, so the surface is identical across tasks and the only
 * thing that changes between instances is which resource and which values the brief names.
 *
 * `required` is checked before `apply` runs, so an operation may coerce its arguments directly.
 */
export const CONSOLE_OPERATIONS: readonly ApiOperation[] = [
  {
    name: "orders.get",
    description: "Look up an order: its status, its total, and any refund or cancellation already recorded.",
    required: ["orderId"],
    parameters: { orderId: "string" },
    apply: (state, args) => {
      const id = text(args, "orderId");
      const row = table(state, "orders")[id];
      if (!row) return fail(`no such order "${id}"`);
      return ok(
        `order ${id}: status ${String(row["status"])}, total ${String(row["total"])}, refunded ${String(row["refunded"])}`,
      );
    },
  },
  {
    name: "orders.cancel",
    description: "Cancel an order. Records the reason against it.",
    required: ["orderId", "reason"],
    parameters: { orderId: "string", reason: "string" },
    apply: (state, args) => {
      const id = text(args, "orderId");
      const row = table(state, "orders")[id];
      if (!row) return fail(`no such order "${id}"`);
      if (row["status"] === "cancelled") return fail(`order ${id} is already cancelled`);
      row["status"] = "cancelled";
      row["cancelReason"] = text(args, "reason");
      return ok(`order ${id} cancelled`);
    },
  },
  {
    name: "orders.refund",
    description: "Refund an amount against an order. Adds to anything already refunded.",
    required: ["orderId", "amount"],
    parameters: { orderId: "string", amount: "number" },
    apply: (state, args) => {
      const id = text(args, "orderId");
      const row = table(state, "orders")[id];
      if (!row) return fail(`no such order "${id}"`);
      const value = amount(args, "amount");
      if (value === null || value <= 0) return fail("amount must be a positive number");
      row["refunded"] = Number(row["refunded"] ?? 0) + value;
      return ok(`refunded ${value} against order ${id}`);
    },
  },
  {
    name: "tickets.get",
    description: "Look up a support ticket: its status, its escalation tier, and any resolution recorded.",
    required: ["ticketId"],
    parameters: { ticketId: "string" },
    apply: (state, args) => {
      const id = text(args, "ticketId");
      const row = table(state, "tickets")[id];
      if (!row) return fail(`no such ticket "${id}"`);
      return ok(`ticket ${id}: status ${String(row["status"])}, tier ${String(row["tier"])}`);
    },
  },
  {
    name: "tickets.escalate",
    description: "Escalate a ticket to a higher support tier.",
    required: ["ticketId", "tier"],
    parameters: { ticketId: "string", tier: "integer" },
    apply: (state, args) => {
      const id = text(args, "ticketId");
      const row = table(state, "tickets")[id];
      if (!row) return fail(`no such ticket "${id}"`);
      const tier = amount(args, "tier");
      if (tier === null || !Number.isInteger(tier) || tier < 2) {
        return fail("tier must be an integer of 2 or more");
      }
      row["status"] = "escalated";
      row["tier"] = tier;
      return ok(`ticket ${id} escalated to tier ${tier}`);
    },
  },
  {
    name: "tickets.close",
    description: "Close a ticket, recording the resolution.",
    required: ["ticketId", "resolution"],
    parameters: { ticketId: "string", resolution: "string" },
    apply: (state, args) => {
      const id = text(args, "ticketId");
      const row = table(state, "tickets")[id];
      if (!row) return fail(`no such ticket "${id}"`);
      row["status"] = "closed";
      row["resolution"] = text(args, "resolution");
      return ok(`ticket ${id} closed`);
    },
  },
  {
    name: "users.disable",
    description: "Disable an account so its owner can no longer sign in.",
    required: ["userId"],
    parameters: { userId: "string" },
    apply: (state, args) => {
      const id = text(args, "userId");
      const row = table(state, "users")[id];
      if (!row) return fail(`no such account "${id}"`);
      row["enabled"] = false;
      return ok(`account ${id} disabled`);
    },
  },
  {
    name: "users.reset_password",
    description: "Force a password reset for an account. Does not disable it.",
    required: ["userId"],
    parameters: { userId: "string" },
    apply: (state, args) => {
      const id = text(args, "userId");
      const row = table(state, "users")[id];
      if (!row) return fail(`no such account "${id}"`);
      row["passwordReset"] = true;
      return ok(`password reset forced for ${id}`);
    },
  },
  {
    name: "mail.send",
    description: "Send a message. Every field is sent exactly as given.",
    required: ["to", "subject", "body"],
    parameters: { to: "string", subject: "string", body: "string" },
    apply: (state, args) => {
      const to = text(args, "to");
      if (!to.includes("@")) return fail(`"${to}" is not an address`);
      list(state, "outbox").push({
        to,
        subject: text(args, "subject"),
        body: text(args, "body"),
      });
      return ok(`message sent to ${to}`);
    },
  },
  {
    name: "mail.archive",
    description: "Move a message from the inbox to the archive. Does not send anything.",
    required: ["messageId"],
    parameters: { messageId: "string" },
    apply: (state, args) => {
      const id = text(args, "messageId");
      const row = table(state, "mail")[id];
      if (!row) return fail(`no such message "${id}"`);
      row["archived"] = true;
      return ok(`message ${id} archived`);
    },
  },
];

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

/** The starting world. Every resource the brief names exists, plus decoys that do not. */
function consoleWorld(config: {
  readonly orders?: readonly { readonly id: string; readonly total: number }[];
  readonly tickets?: readonly { readonly id: string }[];
  readonly users?: readonly { readonly id: string }[];
  readonly mail?: readonly { readonly id: string }[];
}): ApiState {
  const orders: Record<string, Row> = {};
  for (const order of config.orders ?? []) {
    orders[order.id] = {
      id: order.id,
      status: "placed",
      total: order.total,
      refunded: 0,
      cancelReason: null,
    };
  }

  const tickets: Record<string, Row> = {};
  for (const ticket of config.tickets ?? []) {
    tickets[ticket.id] = { id: ticket.id, status: "open", tier: 1, resolution: null };
  }

  const users: Record<string, Row> = {};
  for (const user of config.users ?? []) {
    users[user.id] = { id: user.id, enabled: true, passwordReset: false };
  }

  const mail: Record<string, Row> = {};
  for (const message of config.mail ?? []) {
    mail[message.id] = { id: message.id, archived: false };
  }

  return { orders, tickets, users, mail, outbox: [] };
}

interface ToolcallConfig {
  readonly id: string;
  readonly measures: string;
  readonly build: (rng: Rng) => {
    readonly brief: string;
    readonly initial: ApiState;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
  };
}

function makeToolcallItem(config: ToolcallConfig): ItemTemplate {
  return {
    id: config.id,
    category: "toolcall",
    measures: config.measures,
    generate: (rng) => {
      const built = config.build(rng);
      return {
        brief: built.brief,
        initial: { files: {}, api: built.initial },
        operations: CONSOLE_OPERATIONS,
        maxSteps: 10,
        checks: [
          {
            id: "first-call",
            weight: 1,
            grader: { type: "toolcall-exact", tool: built.tool, args: built.args },
          },
        ],
        reference: `${built.tool} ${JSON.stringify(built.args)}`,
      };
    },
  };
}

const REASONS = [
  "customer changed their mind",
  "duplicate order",
  "item arrived damaged",
  "address cannot be delivered to",
] as const;

const SUBJECTS = [
  "Your order has shipped",
  "Delivery update",
  "Your refund is on the way",
] as const;

const HANDLES = ["ada", "corin", "dax", "fen", "greta"] as const;

/** Order id and a decoy id that is close enough to be checked rather than assumed. */
function orderIds(rng: Rng): { readonly id: string; readonly decoy: string } {
  const id = String(rng.int(1000, 9999));
  let decoy = String(rng.int(1000, 9999));
  while (decoy === id) decoy = String(rng.int(1000, 9999));
  return { id, decoy };
}

export const TOOLCALL_ITEMS: readonly ItemTemplate[] = [
  makeToolcallItem({
    id: "toolcall.orders-cancel",
    measures:
      "Cancelling an order rather than refunding it, with the reason the brief quotes, when both tools exist and both would be plausible.",
    build: (rng) => {
      const { id, decoy } = orderIds(rng);
      const reason = rng.pick(REASONS);
      return {
        brief: `Order ${id} is still open, and the customer has asked us to cancel it. Cancel it and record the reason exactly as: "${reason}". Do nothing else.`,
        initial: consoleWorld({
          orders: [
            { id, total: rng.int(2000, 20000) / 100 },
            { id: decoy, total: rng.int(2000, 20000) / 100 },
          ],
        }),
        tool: "orders.cancel",
        args: { orderId: id, reason },
      };
    },
  }),

  makeToolcallItem({
    id: "toolcall.tickets-escalate",
    measures:
      "Escalating a ticket rather than closing it, on the right ticket, with the tier as a number.",
    build: (rng) => {
      const id = String(rng.int(100, 999));
      const decoy = String(rng.int(100, 999));
      const tier = rng.int(2, 4);
      return {
        brief: `Support ticket ${id} has been open for three days without an answer. Escalate it to tier ${tier}. Do nothing else.`,
        initial: consoleWorld({
          tickets: [{ id }, { id: decoy === id ? `${decoy}1` : decoy }],
        }),
        tool: "tickets.escalate",
        args: { ticketId: id, tier },
      };
    },
  }),

  makeToolcallItem({
    id: "toolcall.users-disable",
    measures:
      "Disabling an account rather than resetting its password, which is the neighbouring operation on the same resource.",
    build: (rng) => {
      const id = rng.pick(HANDLES);
      const decoy = rng.pick(HANDLES.filter((handle) => handle !== id));
      return {
        brief: `The account "${id}" belongs to someone who left the company last week and must not be able to sign in again. Disable it. Do nothing else.`,
        initial: consoleWorld({ users: [{ id }, { id: decoy }] }),
        tool: "users.disable",
        args: { userId: id },
      };
    },
  }),

  makeToolcallItem({
    id: "toolcall.mail-send",
    measures:
      "Sending a message rather than archiving one, with the address, subject, and body the brief quotes reproduced exactly.",
    build: (rng) => {
      const handle = rng.pick(HANDLES);
      const to = `${handle}@example.com`;
      const subject = rng.pick(SUBJECTS);
      const body = "Your parcel left our warehouse this morning.";
      return {
        brief: `Write to the customer at ${to}. Use the subject exactly as: "${subject}". Use the body exactly as: "${body}". Do nothing else.`,
        initial: consoleWorld({ mail: [{ id: `m-${rng.int(100, 999)}` }] }),
        tool: "mail.send",
        args: { to, subject, body },
      };
    },
  }),

  makeToolcallItem({
    id: "toolcall.orders-refund",
    measures:
      "Refunding an order rather than cancelling it, with the amount as a number rather than as text.",
    build: (rng) => {
      const { id, decoy } = orderIds(rng);
      const value = rng.int(1500, 25000) / 100;
      return {
        brief: `Order ${id} arrived damaged and the customer is keeping it. Refund $${value.toFixed(2)} against that order. Do nothing else.`,
        initial: consoleWorld({
          orders: [
            { id, total: rng.int(2000, 26000) / 100 },
            { id: decoy, total: rng.int(2000, 26000) / 100 },
          ],
        }),
        tool: "orders.refund",
        args: { orderId: id, amount: value },
      };
    },
  }),
];
