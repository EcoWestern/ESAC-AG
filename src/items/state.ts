/**
 * State tracking across steps: using something that is no longer available.
 *
 * Ten points, two items, five each. Both items turn on one property of the environment: a report
 * can be fetched exactly once. The figures are returned, they are not stored anywhere the model
 * can read, and the service refuses to repeat itself, so the only way to finish is to have kept
 * what mattered from an earlier observation.
 *
 * That property is why this is a category rather than a harder reading task:
 *
 *   - for a model, the context window is the state, and every step pushes on it;
 *   - a model that loses a value will try to fetch it again, which the state records, and the
 *     second attempt is scored rather than forgiven;
 *   - nothing about the final environment reveals whether the model remembered or re-derived,
 *     so the fetch count is graded as its own check.
 *
 * What this does not measure is worth stating too: it does not test a long horizon. The
 * environment is deliberately small and the budget is fifteen calls, so the recall distance is a
 * handful of steps. A longer version would measure something else, and this suite is meant to be
 * short and cheap rather than exhaustive.
 */

import type { Check, ItemTemplate } from "../types.ts";
import type { Rng } from "../rng.ts";
import { CONSOLE_OPERATIONS } from "./toolcall.ts";
import { EXTRA_OPERATIONS, renderReport, serviceWorld, type Row } from "./support.ts";

const MAX_STEPS = 12;
const OPERATIONS = [...CONSOLE_OPERATIONS, ...EXTRA_OPERATIONS];

const FIGURE_NAMES = [
  "closing stock",
  "open orders",
  "refunded last week",
  "average order value",
  "warehouse units",
  "pending invoices",
] as const;

/**
 * The figures item.
 *
 * Five rows, one fetch, and a file to write. The rows are returned as text, so the model has the
 * answer in front of it for exactly as long as it keeps it.
 */
const figuresRecall: ItemTemplate = {
  id: "state.figures-recall",
  category: "state",
  measures:
    "Copying values out of a one-shot observation accurately, with no way to ask for them again.",
  generate: (rng: Rng) => {
    const reportId = `r-${rng.int(100, 999)}`;
    const names = rng.sample(FIGURE_NAMES, 5);
    const rows: Row[] = names.map((name) => ({ name, value: rng.int(100, 99000) }));
    const rendered = renderReport(rows);

    const initial = serviceWorld({ reports: [{ id: reportId, rows }] });

    const checks: readonly Check[] = [
      {
        id: "figures",
        weight: 3,
        grader: {
          type: "state-diff",
          expected: { files: { "figures.txt": rendered }, api: {} },
          lenientText: ["figures.txt"],
        },
      },
      {
        id: "fetched-once",
        weight: 2,
        grader: {
          type: "state-diff",
          expected: { files: {}, api: { fetched: { [reportId]: 1 } } },
        },
      },
    ];

    const brief = [
      `Report "${reportId}" holds five figures. Fetch it, then write the figures into "figures.txt" exactly as the report returned them: one line per figure, each line the figure's name, a colon, a space, then its value, in the order the report lists them. Nothing else in the file.`,
      "",
      "The report is returned once. Asking for it a second time fails, so read it carefully the first time: you cannot go back for it.",
      "",
      `You have ${MAX_STEPS} tool calls. Reply with plain text when the file is written.`,
    ].join("\n");

    return {
      brief,
      initial: { files: {}, api: initial },
      operations: OPERATIONS,
      maxSteps: MAX_STEPS,
      checks,
    };
  },
};

/**
 * The queue item.
 *
 * The report names tickets and the tier each one needs. The work happens after the report is
 * gone, so a model that reads it, acts on the first line, and looks back has nothing to look at.
 */
const actionRecall: ItemTemplate = {
  id: "state.action-recall",
  category: "state",
  measures:
    "Carrying a list of instructions out of a one-shot observation and acting on all of it, after the source is gone.",
  generate: (rng: Rng) => {
    const reportId = `q-${rng.int(100, 999)}`;
    const ticketIds = rng.sample(["101", "208", "314", "427", "553", "661", "702", "819"], 4);

    // The tier is not the same for every ticket, so a model that applies one tier to all of them
    // is caught by the state rather than by a comment in the brief.
    const tiers = rng.shuffle([2, 2, 3, 4]).slice(0, ticketIds.length);
    const rows: Row[] = ticketIds.map((id, index) => ({
      name: `ticket ${id}`,
      value: tiers[index] ?? 2,
    }));

    const initial = serviceWorld({
      tickets: ticketIds.map((id) => ({ id })),
      reports: [{ id: reportId, rows }],
    });

    // Only the two fields the item is about, per ticket: a full row would credit a model for the
    // fields it did not touch.
    const expectedTickets: Record<string, unknown> = {};
    ticketIds.forEach((id, index) => {
      expectedTickets[id] = { status: "escalated", tier: tiers[index] ?? 2 };
    });

    const checks: readonly Check[] = [
      {
        id: "escalated",
        weight: 3,
        grader: { type: "state-diff", expected: { files: {}, api: { tickets: expectedTickets } } },
      },
      {
        id: "fetched-once",
        weight: 2,
        grader: {
          type: "state-diff",
          expected: { files: {}, api: { fetched: { [reportId]: 1 } } },
        },
      },
    ];

    const brief = [
      `Report "${reportId}" lists tickets that have breached their response time, and for each one the tier it must be escalated to. Fetch it once, then escalate every ticket it names to the tier it gives.`,
      "",
      "The report is returned once and is not stored anywhere. Nobody has written the list down, so the escalation has to come from what you read.",
      "",
      `You have ${MAX_STEPS} tool calls. Do not touch any ticket the report does not name. Reply with plain text when the escalations are done.`,
    ].join("\n");

    return {
      brief,
      initial: { files: {}, api: initial },
      operations: OPERATIONS,
      maxSteps: MAX_STEPS,
      checks,
    };
  },
};

export const STATE_ITEMS: readonly ItemTemplate[] = [figuresRecall, actionRecall];
