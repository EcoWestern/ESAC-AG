/**
 * Error recovery: diagnosing a failing program and fixing the cause.
 *
 * Ten points, two items, five each. Each item ships a script that genuinely fails, a trace that
 * records the failure, and the data that produced it, and the grading runs the script after the
 * model has finished.
 *
 * Three things make this a different category from code generation rather than a harder version
 * of it:
 *
 *   - the artifact already exists, so the work starts with reading rather than writing;
 *   - the failure is reproducible inside the environment, so a model that guesses instead of
 *     running the script is choosing to guess;
 *   - the fix has to keep working on cases the visible data does not cover, which is where a
 *     patch that special-cases the symptom falls over.
 *
 * The test suite runs each broken script and asserts that it really fails, and runs each
 * reference solution and asserts that it passes. A recovery item whose script already worked
 * would measure nothing, and the only way to know is to run it.
 */

import type { HiddenTest, ItemTemplate } from "../types.ts";
import type { Rng } from "../rng.ts";

const MAX_STEPS = 12;

// ---------------------------------------------------------------------------
// The report that prints its own header
// ---------------------------------------------------------------------------

const BROKEN_REPORT = [
  "// Prints the rows of a CSV on standard input, largest amount first.",
  "const fs = require('node:fs');",
  "",
  "const lines = fs.readFileSync(0, 'utf8').split('\\n').filter((line) => line.length > 0);",
  "const rows = lines.map((line) => line.split(','));",
  "",
  "rows.sort((a, b) => Number(b[1]) - Number(a[1]));",
  "",
  "for (const row of rows) {",
  "  console.log(row[0] + ' ' + Number(row[1]).toFixed(2));",
  "}",
].join("\n");

const FIXED_REPORT = [
  "// Prints the rows of a CSV on standard input, largest amount first.",
  "const fs = require('node:fs');",
  "",
  "const lines = fs.readFileSync(0, 'utf8').split('\\n').filter((line) => line.length > 0);",
  "const rows = lines.slice(1).map((line) => line.split(','));",
  "",
  "rows.sort((a, b) => Number(b[1]) - Number(a[1]));",
  "",
  "for (const row of rows) {",
  "  console.log(row[0] + ' ' + Number(row[1]).toFixed(2));",
  "}",
].join("\n");

function referenceReport(text: string): string {
  const lines = text
    .split("\n")
    .filter((line) => line.length > 0);
  const rows = lines.slice(1).map((line) => {
    const comma = line.lastIndexOf(",");
    return { name: line.slice(0, comma), amount: Number(line.slice(comma + 1)) };
  });
  rows.sort((left, right) => right.amount - left.amount);
  return rows.map((row) => `${row.name} ${row.amount.toFixed(2)}`).join("\n");
}

/** What the broken script prints for a given input, computed in TypeScript. */
function brokenReportOutput(text: string): string {
  const rows = text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
  rows.sort((left, right) => Number(right[1]) - Number(left[1]));
  return rows.map((row) => `${row[0]} ${Number(row[1]).toFixed(2)}`).join("\n");
}

const PARTS = [
  "pump housing",
  "valve seat",
  "gasket roll",
  "bearing set",
  "shaft sleeve",
  "filter drum",
] as const;

function reportCase(rng: Rng, index: number): HiddenTest {
  const names = rng.sample(PARTS, rng.int(2, 5));
  const rows = names.map((name) => ({ name, amount: rng.int(500, 60000) / 100 }));
  const stdin = ["part,price", ...rows.map((row) => `${row.name},${row.amount.toFixed(2)}`)].join("\n");
  return { name: `case-${index}-${rows.length}-rows`, stdin, expectedStdout: referenceReport(stdin) };
}

const reportRecovery: ItemTemplate = {
  id: "recovery.header-row",
  category: "recovery",
  measures:
    "Diagnosing a wrong output whose cause is a row that should have been skipped, rather than patching the symptom in the loop.",
  generate: (rng: Rng) => {
    const tests = Array.from({ length: 4 }, (_unused, index) => reportCase(rng, index));
    const sample = tests[0]?.stdin ?? "";

    const trace = [
      "$ cat data.csv",
      sample,
      "",
      "$ node report.js < data.csv",
      brokenReportOutput(sample),
      "",
      "Expected, largest first, with the header line absent:",
      referenceReport(sample),
    ].join("\n");

    const brief = [
      'The script "report.js" in this directory reads a CSV on standard input and prints its rows, largest amount first, as a name, a space, and the amount to two decimals.',
      "",
      'It does not do that. "trace.txt" records what it printed for the data in "data.csv", next to what it should have printed. The sort order is correct. Something else is wrong, and the same mistake will show up on any input of this shape.',
      "",
      "Fix report.js in place so that it works for any input of this shape, not only for the sample. Keep the file name and the output format.",
      "",
      `You can run it yourself with exec_run, and you should: the failure is reproducible here. You have ${MAX_STEPS} tool calls. Reply with plain text when the script works.`,
    ].join("\n");

    return {
      brief,
      initial: {
        files: {
          "report.js": BROKEN_REPORT,
          "data.csv": `${sample}\n`,
          "trace.txt": `${trace}\n`,
        },
        api: {},
      },
      operations: [],
      execution: true,
      maxSteps: MAX_STEPS,
      checks: [{ id: "hidden-tests", weight: 1, grader: { type: "hidden-tests", entry: "report.js", tests } }],
      referenceSolution: FIXED_REPORT,
    };
  },
};

// ---------------------------------------------------------------------------
// The totals script that cannot cope with nothing
// ---------------------------------------------------------------------------

const BROKEN_TOTALS = [
  "// Prints the total of the amounts in a CSV on standard input, and the largest row.",
  "const fs = require('node:fs');",
  "",
  "const lines = fs.readFileSync(0, 'utf8').split('\\n');",
  "const rows = lines.slice(1).map((line) => {",
  "  const parts = line.split(',');",
  "  return { name: parts[0], amount: Number(parts[1]) };",
  "});",
  "",
  "const total = rows.reduce((sum, row) => sum + row.amount, 0);",
  "const largest = rows.reduce((top, row) => (row.amount > top.amount ? row : top));",
  "",
  "console.log(total.toFixed(2));",
  "console.log(largest.name);",
].join("\n");

const FIXED_TOTALS = [
  "// Prints the total of the amounts in a CSV on standard input, and the largest row.",
  "const fs = require('node:fs');",
  "",
  "const lines = fs",
  "  .readFileSync(0, 'utf8')",
  "  .split('\\n')",
  "  .map((line) => line.trim())",
  "  .filter((line) => line.length > 0);",
  "",
  "const rows = lines.slice(1).map((line) => {",
  "  const comma = line.lastIndexOf(',');",
  "  return { name: line.slice(0, comma), amount: Number(line.slice(comma + 1)) };",
  "});",
  "",
  "if (rows.length === 0) {",
  "  console.log('0.00');",
  "} else {",
  "  const total = rows.reduce((sum, row) => sum + row.amount, 0);",
  "  const largest = rows.reduce((top, row) => (row.amount > top.amount ? row : top));",
  "  console.log(total.toFixed(2));",
  "  console.log(largest.name);",
  "}",
].join("\n");

function referenceTotals(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rows = lines.slice(1).map((line) => {
    const comma = line.lastIndexOf(",");
    return { name: line.slice(0, comma), amount: Number(line.slice(comma + 1)) };
  });
  if (rows.length === 0) return "0.00";
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  let largest = rows[0]!;
  for (const row of rows) if (row.amount > largest.amount) largest = row;
  return `${total.toFixed(2)}\n${largest.name}`;
}

const SUPPLIES = ["rope coil", "paint tin", "bolt pack", "gloves", "helmet", "tarp"] as const;

/** Cases chosen so that the two ways this script breaks are both exercised. */
function totalsCases(rng: Rng): HiddenTest[] {
  const make = (name: string, rows: readonly { name: string; amount: number }[], raw?: string): HiddenTest => {
    const stdin =
      raw ?? ["item,price", ...rows.map((row) => `${row.name},${row.amount.toFixed(2)}`)].join("\n");
    return { name, stdin, expectedStdout: referenceTotals(stdin) };
  };

  const normal = rng.sample(SUPPLIES, 3).map((name) => ({
    name,
    amount: rng.int(500, 40000) / 100,
  }));

  return [
    make("three-rows", normal),
    make("header-only", [], "item,price"),
    make("empty-input", [], ""),
    make("trailing-newline", normal, `${["item,price", ...normal.map((row) => `${row.name},${row.amount.toFixed(2)}`)].join("\n")}\n`),
  ];
}

const totalsRecovery: ItemTemplate = {
  id: "recovery.empty-input",
  category: "recovery",
  measures:
    "Recognising that a crash is about a case the input can contain rather than about the data on hand, and fixing the general case.",
  generate: (rng: Rng) => {
    const tests = totalsCases(rng);
    const sample = tests[0]?.stdin ?? "";

    const trace = [
      "$ cat stores.csv",
      sample,
      "",
      "$ node totals.js < stores.csv",
      referenceTotals(sample),
      "",
      "$ node totals.js < empty.csv",
      "TypeError: Reduce of empty array with no initial value",
      "    at Array.reduce (<anonymous>)",
      "    at Object.<anonymous> (totals.js:11:28)",
      "",
      "The same script also prints nonsense when the file ends with a blank line.",
    ].join("\n");

    const brief = [
      'The script "totals.js" reads a CSV on standard input with a header line and rows of "name,amount", and prints the sum of the amounts to two decimals followed by the name of the largest row.',
      "",
      'It works for some inputs and fails for others. "trace.txt" records two failures: one when the file has no rows at all, and one mentioned at the end of the file when the input ends with a blank line. "stores.csv" holds data it handles correctly.',
      "",
      "Fix totals.js in place so that it handles every input of this shape: no data rows, a trailing blank line, and any number of normal rows. Keep the file name and the output format, and keep the two lines of output for normal input.",
      "",
      `You can run it yourself with exec_run, including on inputs you make up. You have ${MAX_STEPS} tool calls. Reply with plain text when the script works.`,
    ].join("\n");

    return {
      brief,
      initial: {
        files: {
          "totals.js": BROKEN_TOTALS,
          "stores.csv": `${sample}\n`,
          "trace.txt": `${trace}\n`,
        },
        api: {},
      },
      operations: [],
      execution: true,
      maxSteps: MAX_STEPS,
      checks: [
        { id: "hidden-tests", weight: 1, grader: { type: "hidden-tests", entry: "totals.js", tests } },
      ],
      referenceSolution: FIXED_TOTALS,
    };
  },
};

export const RECOVERY_ITEMS: readonly ItemTemplate[] = [reportRecovery, totalsRecovery];
