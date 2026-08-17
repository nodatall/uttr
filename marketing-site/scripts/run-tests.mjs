import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([".git", ".next", "node_modules"]);
const testFilePattern = /(?:^|\.)test\.(?:[cm]?[jt]sx?)$/;

async function findTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...(await findTestFiles(path)));
      }
      continue;
    }

    if (entry.isFile() && testFilePattern.test(entry.name)) {
      files.push(path);
    }
  }

  return files;
}

function runBatch(files) {
  if (files.length === 0) {
    return;
  }

  const result = spawnSync(process.execPath, ["test", ...files], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const testFiles = (await findTestFiles(rootDir)).sort();
const isolatedFiles = [];
const sharedFiles = [];

for (const file of testFiles) {
  const source = await readFile(file, "utf8");
  const relativePath = relative(rootDir, file);
  if (source.includes("mock.module(")) {
    isolatedFiles.push(relativePath);
  } else {
    sharedFiles.push(relativePath);
  }
}

// Bun module overrides persist for the lifetime of the test process. Keep each
// file that installs one out of the shared process so test order cannot leak it.
runBatch(sharedFiles);
for (const file of isolatedFiles) {
  runBatch([file]);
}
