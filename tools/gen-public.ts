/**
 * Generate or verify the reproducible public ESAC-AG instance snapshot.
 *
 * Deliberately a thin wrapper over `src/artifact.ts`, so this script and `esac export` produce
 * the same bytes. Two implementations of one artifact is how the shipped file and the documented
 * command drift apart.
 */

import { resolve } from "node:path";

import { writeArtifact } from "../src/artifact.ts";
import { PUBLIC_DATASET_SEED } from "../src/version.ts";

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const output = resolve(
  process.cwd(),
  args.find((arg) => !arg.startsWith("--")) ?? "public/esac-ag-v1.0-public.jsonl",
);

const result = writeArtifact(output, "public", PUBLIC_DATASET_SEED, { verify });

if (verify) {
  if (!result.unchanged) throw new Error(`${output} is not reproducible from the public seed`);
  console.log(`${output} is reproducible: ${result.itemCount} instances match the public seed`);
} else {
  console.log(`wrote ${result.itemCount} public instances to ${output}`);
}
