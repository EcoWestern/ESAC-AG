/**
 * Bounded multi-step planning: reaching a goal state inside a tight step budget.
 *
 * Ten points, two items, five each. The construct is the plan, and the plan is graded by
 * diffing the environment rather than by reading the model's description of a plan. A model that
 * narrates a good plan and changes nothing scores zero, which is the point: agentic work is
 * measured by what it did.
 *
 * Both items are built so that the naive route fits the budget with one or two calls to spare.
 * The pressure is not cruelty, it is that exploration has to be rationed: every call spent
 * listing a directory twice is a call not available for the last move. The budget is stated in
 * the brief, and the brief is the only place it is stated, exactly as the harness enforces it.
 *
 * The invoices item also contains a file that is tempting and irrelevant. Reading it costs a
 * call, and the budget is set so that the model can afford it and still finish, which makes the
 * distractor a test of judgement rather than a trap.
 */

import type { Check, ItemTemplate } from "../types.ts";
import type { Rng } from "../rng.ts";
import { CONSOLE_OPERATIONS } from "./toolcall.ts";
import { money, serviceWorld } from "./support.ts";

/** The budget for both planning items, inside the range the specification fixes. */
const MAX_STEPS = 15;

const VENDORS = [
  "Brightwell Supplies",
  "Corrimal Freight",
  "Dunmore Paper",
  "Eastern Rail Parts",
  "Fenwick Chemicals",
] as const;

interface Invoice {
  readonly name: string;
  readonly content: string;
  readonly totalCents: number;
  readonly paid: boolean;
}

/**
 * The invoices item.
 *
 * Six files, a budget of fifteen, and a minimum route of fourteen: list once, read six, move
 * six, write once. There is no room for a second listing, which is what a plan is for.
 */
const invoiceTriage: ItemTemplate = {
  id: "planning.invoice-triage",
  category: "planning",
  measures:
    "Sorting a directory by a value inside each file, then producing a summary whose order depends on values read from every one of them, inside a budget that forbids re-reading.",
  generate: (rng: Rng) => {
    const invoices: Invoice[] = [];
    const paidFlags = rng.sample([true, true, true, false, false, false], 6);

    for (let index = 0; index < 6; index++) {
      const name = `inv-0${index + 1}.txt`;
      const totalCents = rng.int(4500, 98000);
      const paid = paidFlags[index] ?? false;
      const vendor = VENDORS[index % VENDORS.length] ?? "Vendor";
      invoices.push({
        name,
        content: `vendor: ${vendor}\ntotal: ${money(totalCents)}\nstatus: ${paid ? "paid" : "unpaid"}\n`,
        totalCents,
        paid,
      });
    }

    const files: Record<string, string> = {
      "notes.md": "Office note: the building is closed on Friday. Nothing in this file is needed.\n",
    };
    for (const invoice of invoices) files[`invoices/${invoice.name}`] = invoice.content;

    const paidInvoices = invoices.filter((invoice) => invoice.paid);
    const ordered = [...paidInvoices].sort((left, right) => {
      if (right.totalCents !== left.totalCents) return right.totalCents - left.totalCents;
      return left.name.localeCompare(right.name);
    });
    const sumCents = paidInvoices.reduce((total, invoice) => total + invoice.totalCents, 0);
    const totalsFile = [
      ...ordered.map((invoice) => `${invoice.name.replace(/\.txt$/, "")} ${money(invoice.totalCents)}`),
      `total ${money(sumCents)}`,
    ].join("\n");

    const movedFiles: Record<string, string> = {};
    for (const invoice of invoices) {
      movedFiles[`${invoice.paid ? "paid" : "unpaid"}/${invoice.name}`] = invoice.content;
    }

    const checks: readonly Check[] = [
      { id: "moved", weight: 3, grader: { type: "state-diff", expected: { files: movedFiles, api: {} } } },
      {
        id: "totals",
        weight: 3,
        grader: {
          type: "state-diff",
          expected: { files: { "totals.txt": totalsFile }, api: {} },
          lenientText: ["totals.txt"],
        },
      },
      {
        id: "cleared",
        weight: 1,
        grader: { type: "state-diff", expected: { files: {}, api: {} }, absent: ["invoices/"] },
      },
    ];

    const brief = [
      `The directory "invoices/" holds exactly ${invoices.length} invoice files, plus a note that is not part of the work. Each invoice has a "status:" line that is either "paid" or "unpaid".`,
      "",
      "Move every invoice into \"paid/\" or \"unpaid/\" according to its status line, keeping the file names. Then write \"totals.txt\" containing:",
      "",
      "- one line per paid invoice: the file name without its extension, a single space, then that invoice's total exactly as it appears in the file;",
      "- those lines sorted by total, largest first, with ties broken by file name ascending;",
      "- a final line \"total \" followed by the sum of the paid totals.",
      "",
      `You have ${MAX_STEPS} tool calls. Listing a directory, reading a file, and moving a file are one call each, so read what you need and no more. When the work is done, reply with plain text.`,
    ].join("\n");

    return {
      brief,
      initial: { files, api: {} },
      operations: [],
      maxSteps: MAX_STEPS,
      checks,
    };
  },
};

/**
 * The refund item.
 *
 * The boundary case is the whole item: an order of exactly 150.00 must not be refunded, and a
 * model that reads "above 150" as "150 or more" gets it wrong. Six reads, some refunds, one
 * write, and four calls of slack.
 */
const refundWave: ItemTemplate = {
  id: "planning.refund-wave",
  category: "planning",
  measures:
    "Reading a table, deciding which rows cross a stated threshold, acting on exactly those, and reporting them in a stated order.",
  generate: (rng: Rng) => {
    const ids = [...rng.sample(["1041", "1103", "1187", "1206", "1349", "1402", "1518", "1633"], 6)].sort(
      (left, right) => Number(left) - Number(right),
    );

    // One order sits exactly on the threshold, on purpose, at a position the seed chooses rather
    // than always first: the boundary has to be found by reading, not by noticing a pattern.
    const totalsCents = rng.sample([8900, 12450, 15875, 19900, 24300, 30450], 5);
    totalsCents.splice(rng.int(0, 6), 0, 15000);

    const orders = ids.map((id, index) => ({
      id,
      total: (totalsCents[index] ?? 10000) / 100,
    }));

    const initial = serviceWorld({ orders });
    const shouldRefund = orders.filter((order) => order.total > 150);

    // The expectation names only the field the item is about, one entry per decision, rather
    // than copying whole rows. Copying rows would credit the model for every field it never
    // touched, which is how a do-nothing run earns most of a check.
    const expectedOrders: Record<string, Record<string, number>> = {};
    for (const order of orders) {
      expectedOrders[order.id] = {
        refunded: shouldRefund.some((candidate) => candidate.id === order.id) ? 12.5 : 0,
      };
    }

    const refundedFile = shouldRefund.map((order) => order.id).join("\n");

    const checks: readonly Check[] = [
      {
        id: "refunds",
        weight: 3,
        grader: { type: "state-diff", expected: { files: {}, api: { orders: expectedOrders } } },
      },
      {
        id: "report",
        weight: 2,
        grader: {
          type: "state-diff",
          expected: { files: { "refunded.txt": refundedFile }, api: {} },
          lenientText: ["refunded.txt"],
        },
      },
    ];

    const brief = [
      `The order table holds ${orders.length} orders. Refund 12.50 against every order whose total is **above** 150.00, and against no other order.`,
      "",
      "Then write \"refunded.txt\": one order id per line, in ascending numeric order, one line per order you refunded, and nothing else in the file.",
      "",
      `You have ${MAX_STEPS} tool calls. Looking an order up costs one call. Do not cancel anything, and do not touch any other order. When the work is done, reply with plain text.`,
    ].join("\n");

    return {
      brief,
      initial: { files: {}, api: initial },
      operations: CONSOLE_OPERATIONS,
      maxSteps: MAX_STEPS,
      checks,
    };
  },
};

export const PLANNING_ITEMS: readonly ItemTemplate[] = [invoiceTriage, refundWave];
