// main.ts
// Copies the PNG that sits next to this script (entry.png) into the
// directory given by the MAKEFUN_OUTPUT_DIR environment variable, then
// verifies that the written file is a non-empty PNG no larger than 1 MiB.
//
// If the source fails validation, nothing is written. The output is written
// to a temporary file in the same directory, read back and checked to be
// byte-identical to the source, and only then atomically renamed onto
// entry.png. A run that is killed mid-write therefore never leaves a
// truncated entry.png behind; on a validation failure the temp file is
// deleted and the program exits with code 1.
//
// Only Node built-ins are used, so no `npm install` is required.
// Run with Node 22, e.g.: node --experimental-strip-types main.ts

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const FILE_NAME = "entry.png";

// Largest file we accept, for both the source and the written output.
const MAX_BYTES = 1024 * 1024; // 1 MiB = 1048576 bytes

// Every valid PNG file begins with these eight bytes.
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// Resolve the directory that contains this script.
// `import.meta.dirname` is available in modern Node; fall back to the
// current working directory if it is missing for any reason.
function scriptDir(): string {
  return import.meta.dirname ?? process.cwd();
}

// Print an error to stderr and terminate with a non-zero exit code.
function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Returns a description of the first problem found, or null if the bytes
// form a non-empty PNG within the size limit. `label` names the file in
// the message (e.g. "Source file /path/entry.png").
function findPngProblem(data: Buffer, label: string): string | null {
  if (data.length === 0) {
    return `${label} is empty (0 bytes).`;
  }
  if (data.length > MAX_BYTES) {
    return `${label} is ${data.length} bytes, which exceeds the 1 MiB limit (${MAX_BYTES} bytes).`;
  }
  if (!data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return `${label} does not start with the PNG signature (89 50 4E 47 0D 0A 1A 0A).`;
  }
  return null;
}

// Delete `path`, treating "already gone" (ENOENT) as success.
async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

// Delete the bad output, then fail with a message saying it was removed
// (or, if deletion itself failed, saying so).
async function failAndRemoveOutput(path: string, problem: string): Promise<never> {
  try {
    await removeIfPresent(path);
  } catch (err) {
    fail(`${problem} Additionally, the bad output could not be removed: ${errorMessage(err)}`);
  }
  fail(`${problem} The bad output file ${path} was removed.`);
}

async function main(): Promise<void> {
  // The destination directory must be provided via the environment.
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR;
  if (!outputDir) {
    fail("MAKEFUN_OUTPUT_DIR environment variable is not set.");
  }

  const sourcePath = join(scriptDir(), FILE_NAME);
  const targetDir = resolve(outputDir);
  const targetPath = join(targetDir, FILE_NAME);

  // Read and validate the source before touching the output directory,
  // so an invalid source results in nothing being written.
  const data = await readFile(sourcePath);
  const sourceProblem = findPngProblem(data, `Source file ${sourcePath}`);
  if (sourceProblem !== null) {
    fail(sourceProblem);
  }

  await mkdir(targetDir, { recursive: true });

  // Fixed temp name in the target directory (same filesystem, so rename is
  // atomic). A fixed name means a leftover from a killed run is simply
  // overwritten next time rather than accumulating.
  const tempPath = join(targetDir, `.${FILE_NAME}.tmp`);
  try {
    await writeFile(tempPath, data, { flush: true });
  } catch (err) {
    return failAndRemoveOutput(
      tempPath,
      `Could not write temporary file ${tempPath}: ${errorMessage(err)}.`,
    );
  }

  // Verify what actually reached disk before publishing it.
  let written: Buffer;
  try {
    written = await readFile(tempPath);
  } catch (err) {
    return failAndRemoveOutput(
      tempPath,
      `Could not read back temporary file ${tempPath}: ${errorMessage(err)}.`,
    );
  }
  const outputProblem =
    findPngProblem(written, `Output file ${tempPath}`) ??
    (written.equals(data) ? null : `Output file ${tempPath} does not match the source bytes.`);
  if (outputProblem !== null) {
    return failAndRemoveOutput(tempPath, outputProblem);
  }

  try {
    await rename(tempPath, targetPath);
  } catch (err) {
    return failAndRemoveOutput(
      tempPath,
      `Could not move ${tempPath} to ${targetPath}: ${errorMessage(err)}.`,
    );
  }

  console.log(`Copied ${sourcePath} -> ${targetPath} (${written.length} bytes)`);
}

main().catch((err: unknown) => {
  fail(errorMessage(err));
});
