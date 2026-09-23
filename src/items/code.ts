/**
 * Code generation and execution: writing a program that passes tests it never saw.
 *
 * Fifteen points, three items, five each, graded by running the artifact rather than by reading
 * it. The hidden tests are generated from the same seed as the task, so two runs of the same
 * instance run the same tests, and the tests are never in the environment the model works in.
 *
 * Each item carries a reference solution, and the test suite runs it against the item's own
 * hidden tests. That is the property that stops this category from rotting: an item whose tests
 * nothing can pass measures nothing, and the way to know is to pass them with something.
 *
 * Every item states the input and the output format exactly. The difficulty is supposed to be
 * the program, not the guesswork about what the grader wants, so whitespace and ordering rules
 * that the grader cares about are written out in the brief.
 */

import type { Check, HiddenTest, ItemTemplate } from "../types.ts";
import type { Rng } from "../rng.ts";

const SOLUTION = "solution.js";
const MAX_STEPS = 12;

/** What every item says about the contract of the artifact, verbatim and in one place. */
function contract(): readonly string[] {
  return [
    `- Write the program to the file "${SOLUTION}".`,
    `- It will be run as \`node ${SOLUTION}\` with no arguments, in a directory containing only the files you left there.`,
    "- Read the input from standard input, and write the result to standard output.",
    "- Compare output exactly. Trailing whitespace at the very end is ignored; everything else is not.",
    "- Only Node's built-in modules are available. There is no network and no installed package.",
    "",
    `You can run it yourself with exec_run, and you should: it is the only way to see whether it works. When you are satisfied, reply with plain text. You have ${MAX_STEPS} tool calls.`,
  ];
}

/** Run the model's program against generated cases. The only check a code item has. */
function hiddenTestCheck(tests: readonly HiddenTest[]): Check {
  return {
    id: "hidden-tests",
    weight: 1,
    grader: { type: "hidden-tests", entry: SOLUTION, tests },
  };
}

// ---------------------------------------------------------------------------
// Repeated words
// ---------------------------------------------------------------------------

const WORD_POOL = [
  "the",
  "report",
  "ships",
  "today",
  "late",
  "and",
  "invoice",
  "dock",
  "crane",
  "port",
  "cargo",
  "manifest",
] as const;

/** The reference implementation, in TypeScript, used to compute what the tests expect. */
function referenceRepeatedWords(text: string): string {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
    })
    .map(([word, count]) => `${word} ${count}`)
    .join("\n");
}

/** The same thing as a program, which the test suite runs to prove the item is solvable. */
const REPEATED_WORDS_SOLUTION = [
  "const fs = require('node:fs');",
  "const text = fs.readFileSync(0, 'utf8').toLowerCase();",
  "const counts = new Map();",
  "for (const word of text.match(/[a-z0-9']+/g) || []) {",
  "  counts.set(word, (counts.get(word) || 0) + 1);",
  "}",
  "const rows = [...counts].filter((entry) => entry[1] >= 2);",
  "rows.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));",
  "process.stdout.write(rows.map((entry) => entry[0] + ' ' + entry[1]).join('\\n'));",
].join("\n");

function repeatedWordCase(rng: Rng): HiddenTest {
  const chosen = rng.sample(WORD_POOL, rng.int(4, 9));
  const tokens: string[] = [];
  for (const word of chosen) {
    const times = rng.int(1, 4);
    for (let index = 0; index < times; index++) tokens.push(word);
  }

  const separators = [" ", ", ", "\n", ". ", "; ", "\n\n"];
  let stdin = "";
  rng.shuffle(tokens).forEach((token, index) => {
    stdin += rng.bool(0.5) ? token.toUpperCase() : token;
    if (index < tokens.length - 1) stdin += rng.pick(separators);
  });

  return { name: `case-${chosen.length}-${tokens.length}`, stdin, expectedStdout: referenceRepeatedWords(stdin) };
}

const repeatedWords: ItemTemplate = {
  id: "code.repeated-words",
  category: "code",
  measures:
    "Writing a program that tokenises, counts, filters, and orders, where the ordering rule has a tie-break and the output must match exactly.",
  generate: (rng: Rng) => {
    const tests = Array.from({ length: 4 }, () => repeatedWordCase(rng));

    const brief = [
      "Write a program that reports which words in a text repeat.",
      "",
      "A word is a run of letters, digits, or apostrophes. Everything else separates words. Case is ignored, so \"Report\" and \"report\" are the same word.",
      "",
      "Print one line for each word that appears at least twice, as the word, a single space, then the number of times it appears. Sort the lines by count, highest first, and break ties alphabetically, ascending. If no word repeats, print nothing.",
      "",
      "For example, this input:",
      "",
      "    the crane lifted the cargo, and the crane lowered it",
      "",
      "produces this output:",
      "",
      "    the 3",
      "    crane 2",
      "",
      ...contract(),
    ].join("\n");

    return {
      brief,
      initial: { files: {}, api: {} },
      operations: [],
      execution: true,
      maxSteps: MAX_STEPS,
      checks: [hiddenTestCheck(tests)],
      referenceSolution: REPEATED_WORDS_SOLUTION,
    };
  },
};

// ---------------------------------------------------------------------------
// Column totals
// ---------------------------------------------------------------------------

/** The reference implementation, in TypeScript. */
function referenceColumnTotals(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const rows = lines.slice(1).map((line) => {
    const comma = line.lastIndexOf(",");
    return {
      name: line.slice(0, comma).trim(),
      amount: Number(line.slice(comma + 1).trim()),
    };
  });
  if (rows.length === 0) return "0.00";

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  let top = rows[0]!;
  for (const row of rows) if (row.amount > top.amount) top = row;
  return `${total.toFixed(2)}\n${top.name}`;
}

const COLUMN_TOTALS_SOLUTION = [
  "const fs = require('node:fs');",
  "const lines = fs.readFileSync(0, 'utf8').split('\\n').map((line) => line.trim()).filter((line) => line.length > 0);",
  "const rows = lines.slice(1).map((line) => {",
  "  const comma = line.lastIndexOf(',');",
  "  return { name: line.slice(0, comma).trim(), amount: Number(line.slice(comma + 1).trim()) };",
  "});",
  "if (rows.length === 0) { process.stdout.write('0.00'); }",
  "else {",
  "  let total = 0;",
  "  let top = rows[0];",
  "  for (const row of rows) { total += row.amount; if (row.amount > top.amount) top = row; }",
  "  process.stdout.write(total.toFixed(2) + '\\n' + top.name);",
  "}",
].join("\n");

const GOODS = [
  "anchor chain",
  "ballast pump",
  "cable drum",
  "deck winch",
  "engine mount",
  "fender set",
  "gantry rail",
  "hawser line",
] as const;

function columnTotalsCase(rng: Rng, index: number): HiddenTest {
  const names = rng.sample(GOODS, rng.int(1, 6));
  const rows = names.map((name) => ({
    name,
    amount: rng.int(150, 90000) / 100,
  }));

  const stdin = ["name,amount", ...rows.map((row) => `${row.name},${row.amount.toFixed(2)}`)].join("\n");

  return {
    name: `case-${index}-${rows.length}-rows`,
    stdin,
    expectedStdout: referenceColumnTotals(stdin),
  };
}

const columnTotals: ItemTemplate = {
  id: "code.column-totals",
  category: "code",
  measures:
    "Parsing a small tabular input and reporting two derived values, where rounding and the choice of the largest row both have to be exact.",
  generate: (rng: Rng) => {
    const tests = Array.from({ length: 4 }, (_unused, index) => columnTotalsCase(rng, index));

    const brief = [
      "Write a program that reads a comma-separated table on standard input and reports its total and its largest row.",
      "",
      "The first line is a header and is not data. Every later line is a name, a comma, and an amount. A name may contain spaces but not commas.",
      "",
      "Print two lines: first the sum of all amounts, to exactly two decimal places; then the name of the row with the largest amount. If the table has no data rows, print a single line with 0.00. If two rows share the largest amount, print the one that appears first.",
      "",
      "You may assume every amount is a number, and that input lines have no leading or trailing spaces that matter.",
      "",
      ...contract(),
    ].join("\n");

    return {
      brief,
      initial: { files: {}, api: {} },
      operations: [],
      execution: true,
      maxSteps: MAX_STEPS,
      checks: [hiddenTestCheck(tests)],
      referenceSolution: COLUMN_TOTALS_SOLUTION,
    };
  },
};

// ---------------------------------------------------------------------------
// Date normalising
// ---------------------------------------------------------------------------

function referenceDates(text: string): string {
  const parsed = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/[-./]/).map((part) => Number(part));
      const [year, month, day] = parts;
      return { year: year ?? 0, month: month ?? 1, day: day ?? 1, key: line };
    });

  return parsed
    .sort((left, right) => {
      if (left.year !== right.year) return left.year - right.year;
      if (left.month !== right.month) return left.month - right.month;
      if (left.day !== right.day) return left.day - right.day;
      return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    })
    .map(
      (date) =>
        `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`,
    )
    .join("\n");
}

const DATE_SOLUTION = [
  "const fs = require('node:fs');",
  "const dates = fs.readFileSync(0, 'utf8').split('\\n').map((line) => line.trim()).filter((line) => line.length > 0).map((line) => {",
  "  const parts = line.split(/[-./]/).map(Number);",
  "  return { year: parts[0], month: parts[1], day: parts[2], key: line };",
  "});",
  "dates.sort((a, b) => (a.year - b.year) || (a.month - b.month) || (a.day - b.day) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));",
  "const pad = (value, width) => String(value).padStart(width, '0');",
  "process.stdout.write(dates.map((date) => pad(date.year, 4) + '-' + pad(date.month, 2) + '-' + pad(date.day, 2)).join('\\n'));",
].join("\n");

function dateCase(rng: Rng, index: number): HiddenTest {
  const separators = ["-", "/", "."];
  const rows: string[] = [];
  const keys: { year: number; month: number; day: number; text: string }[] = [];

  const count = rng.int(3, 8);
  for (let position = 0; position < count; position++) {
    const year = rng.int(1999, 2027);
    const month = rng.int(1, 13);
    const day = rng.int(1, 29);
    const separator = rng.pick(separators);
    const messy = rng.bool(0.5);
    const text = messy
      ? `${year}${separator}${month}${separator}${day}`
      : `${year}${separator}${String(month).padStart(2, "0")}${separator}${String(day).padStart(2, "0")}`;
    rows.push(text);
    keys.push({ year, month, day, text });
  }

  const stdin = rows.join("\n");
  return { name: `case-${index}-${rows.length}-dates`, stdin, expectedStdout: referenceDates(stdin) };
}

const dateNormalising: ItemTemplate = {
  id: "code.date-normalising",
  category: "code",
  measures:
    "Writing a parser for several shapes of the same value, then ordering the parsed values rather than the text.",
  generate: (rng: Rng) => {
    const tests = Array.from({ length: 4 }, (_unused, index) => dateCase(rng, index));

    const brief = [
      "Write a program that normalises a list of dates.",
      "",
      "Each line of input is one date, written as year, month, and day separated by a single `-`, `/`, or `.`. The month and day may or may not be zero-padded, and different lines may use different separators. The year always has four digits.",
      "",
      "Print one line per input date, in `YYYY-MM-DD` form with month and day zero-padded to two digits. Sort the lines by date, earliest first, and keep every line: if the same date appears twice, it appears twice in the output. Where two input lines are the same date written differently, either order is accepted.",
      "",
      ...contract(),
    ].join("\n");

    return {
      brief,
      initial: { files: {}, api: {} },
      operations: [],
      execution: true,
      maxSteps: MAX_STEPS,
      checks: [hiddenTestCheck(tests)],
      referenceSolution: DATE_SOLUTION,
    };
  },
};

export const CODE_ITEMS: readonly ItemTemplate[] = [repeatedWords, columnTotals, dateNormalising];
