#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DATASET = path.join(ROOT, "evals/post-processing/golden.jsonl");
const DEFAULT_OUT_DIR = path.join(ROOT, "evals/post-processing/runs");
const DEFAULT_PROVIDER = "ollama";
const DEFAULT_BASE_URLS = {
  ollama: "http://localhost:11434/v1",
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
};
const DEFAULT_MODELS = {
  ollama: "qwen3:14b",
  groq: "openai/gpt-oss-20b",
  openai: "gpt-4.1-mini",
};

function parseArgs(argv) {
  const args = {
    dataset: DEFAULT_DATASET,
    outDir: DEFAULT_OUT_DIR,
    provider: process.env.UTTR_EVAL_PROVIDER || DEFAULT_PROVIDER,
    model: process.env.UTTR_EVAL_MODEL || null,
    baseUrl: process.env.UTTR_EVAL_BASE_URL || null,
    ids: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[i];
    };

    if (arg === "--dataset") args.dataset = path.resolve(next());
    else if (arg === "--out-dir") args.outDir = path.resolve(next());
    else if (arg === "--provider") args.provider = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--base-url") args.baseUrl = next();
    else if (arg === "--ids") args.ids = next().split(",").map((id) => id.trim()).filter(Boolean);
    else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  args.provider = args.provider.trim();
  args.model = args.model || DEFAULT_MODELS[args.provider];
  args.baseUrl = (args.baseUrl || DEFAULT_BASE_URLS[args.provider] || "").replace(/\/$/, "");
  if (!args.model) throw new Error(`No model configured for provider '${args.provider}'`);
  if (!args.baseUrl) throw new Error(`No base URL configured for provider '${args.provider}'`);
  return args;
}

function printUsage() {
  console.log(`Usage: node scripts/run-post-processing-evals.mjs [options]

Options:
  --dataset <path>   JSONL golden set. Default: evals/post-processing/golden.jsonl
  --out-dir <path>   Output directory. Default: evals/post-processing/runs
  --provider <id>    ollama, groq, openai, or custom. Default: ollama
  --model <id>       Model id. Defaults by provider.
  --base-url <url>   OpenAI-compatible base URL. Defaults by provider.
  --ids <ids>        Comma-separated case ids to run.

Environment:
  UTTR_EVAL_PROVIDER, UTTR_EVAL_MODEL, UTTR_EVAL_BASE_URL
  UTTR_GROQ_API_KEY or GROQ_API_KEY for --provider groq
  UTTR_OPENAI_API_KEY or OPENAI_API_KEY for --provider openai
  UTTR_EVAL_API_KEY for custom providers`);
}

function readJsonl(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function strictCleaningPrompt() {
  const settingsPath = path.join(ROOT, "src-tauri/src/settings.rs");
  const source = fs.readFileSync(settingsPath, "utf8");
  const match = source.match(/pub const STRICT_CLEANING_PROMPT: &str = "([\s\S]*?)";/);
  if (!match) {
    throw new Error(`Could not find STRICT_CLEANING_PROMPT in ${settingsPath}`);
  }
  return match[1].replace(/\\"/g, '"');
}

function userPrompt(input) {
  return `# Task
Clean the transcript. Return only the final cleaned transcript inside <uttr_output>...</uttr_output>. Do not include analysis, chat roles, markdown fences, or explanations.

# Input
${input}

# Output format
Wrap only the cleaned transcript like this:
<uttr_output>
...
</uttr_output>`;
}

function apiKeyForProvider(provider) {
  if (provider === "groq") return process.env.UTTR_GROQ_API_KEY || process.env.GROQ_API_KEY || "";
  if (provider === "openai") {
    return process.env.UTTR_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  }
  return process.env.UTTR_EVAL_API_KEY || "";
}

function requestBody(provider, model, messages) {
  const body = { model, messages };
  if (provider === "groq" && model === "openai/gpt-oss-20b") {
    body.max_completion_tokens = 4096;
    body.reasoning_effort = "low";
    body.include_reasoning = false;
  }
  return body;
}

async function sendChatCompletion({ provider, baseUrl, model, systemPrompt, input }) {
  const apiKey = apiKeyForProvider(provider);
  if ((provider === "groq" || provider === "openai") && !apiKey) {
    throw new Error(`Missing API key for provider '${provider}'`);
  }

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const started = performance.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(
      requestBody(provider, model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt(input) },
      ]),
    ),
  });
  const latencyMs = Math.round(performance.now() - started);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json = await response.json();
  const raw = json?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") {
    throw new Error("Response did not contain choices[0].message.content");
  }
  return { raw, output: cleanPostProcessResponse(raw), latencyMs };
}

function cleanPostProcessResponse(content) {
  const tagged = extractTaggedOutput(content, "uttr_output");
  if (tagged !== null) return stripWrappingCodeFence(trimChatStopTokens(tagged));

  let cleaned = content;
  const markers = [
    "<|channel|>final<|message|>",
    "<|channel|>final\n<|message|>",
    "<|final|>",
    "\nfinal answer:",
    "\nfinal:",
    "\n# output\n",
    "\noutput:",
  ];
  const lower = cleaned.toLowerCase();
  let lastMarker = { index: -1, marker: "" };
  for (const marker of markers) {
    const index = lower.lastIndexOf(marker.toLowerCase());
    if (index > lastMarker.index) lastMarker = { index, marker };
  }
  if (lastMarker.index >= 0) {
    cleaned = cleaned.slice(lastMarker.index + lastMarker.marker.length);
  } else {
    for (const prefix of ["final answer:", "final:", "# output\n", "output:"]) {
      if (lower.startsWith(prefix)) {
        cleaned = cleaned.slice(prefix.length);
        break;
      }
    }
  }

  cleaned = removeTaggedBlock(cleaned, "think");
  cleaned = removeTaggedBlock(cleaned, "analysis");
  cleaned = trimChatStopTokens(cleaned);
  cleaned = cleaned.replaceAll("<uttr_output>", "").replaceAll("</uttr_output>", "");
  return stripWrappingCodeFence(cleaned);
}

function extractTaggedOutput(content, tag) {
  const re = new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, "i");
  return content.match(re)?.[1] ?? null;
}

function removeTaggedBlock(content, tag) {
  return content.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "gi"), "");
}

function trimChatStopTokens(content) {
  return content
    .replace(/<\|end\|>\s*$/g, "")
    .replace(/<\|endoftext\|>\s*$/g, "")
    .trim();
}

function stripWrappingCodeFence(content) {
  const trimmed = content.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return (match ? match[1] : trimmed).trim();
}

function includesText(haystack, needle) {
  return haystack.toLowerCase().includes(String(needle).toLowerCase());
}

function includesExactText(haystack, needle) {
  return haystack.includes(String(needle));
}

function scoreCase(testCase, output) {
  const checks = [];
  const expected = testCase.expected || {};
  checks.push({
    name: "non_empty",
    passed: output.trim().length > 0,
  });

  for (const phrase of expected.must_include || []) {
    checks.push({
      name: "must_include",
      value: phrase,
      passed: includesText(output, phrase),
    });
  }
  for (const phrase of expected.must_include_exact || []) {
    checks.push({
      name: "must_include_exact",
      value: phrase,
      passed: includesExactText(output, phrase),
    });
  }
  for (const phrase of expected.must_not_include || []) {
    checks.push({
      name: "must_not_include",
      value: phrase,
      passed: !includesText(output, phrase),
    });
  }
  for (const phrase of expected.must_not_include_exact || []) {
    checks.push({
      name: "must_not_include_exact",
      value: phrase,
      passed: !includesExactText(output, phrase),
    });
  }
  for (const phrase of expected.must_not_equal || []) {
    checks.push({
      name: "must_not_equal",
      value: phrase,
      passed: output.trim().toLowerCase() !== String(phrase).trim().toLowerCase(),
    });
  }

  return {
    deterministic_passed: checks.every((check) => check.passed),
    checks,
  };
}

function reportMarkdown({ run, results }) {
  const passed = results.filter((result) => result.deterministic_passed).length;
  const failed = results.length - passed;
  const byTag = new Map();
  for (const result of results) {
    for (const tag of result.tags || []) {
      const entry = byTag.get(tag) || { total: 0, failed: 0 };
      entry.total += 1;
      if (!result.deterministic_passed) entry.failed += 1;
      byTag.set(tag, entry);
    }
  }

  const lines = [];
  lines.push(`# Post-Processing Eval Review`);
  lines.push("");
  lines.push(`Run: ${run.id}`);
  lines.push(`Provider: ${run.provider}`);
  lines.push(`Model: ${run.model}`);
  lines.push(`Dataset: ${run.dataset}`);
  lines.push(`Started: ${run.started_at}`);
  lines.push(`Finished: ${run.finished_at}`);
  lines.push(`Deterministic: ${passed} passed, ${failed} failed`);
  lines.push("");
  lines.push(`## Tag Summary`);
  lines.push("");
  lines.push(`| tag | total | deterministic failures |`);
  lines.push(`|---|---:|---:|`);
  for (const [tag, entry] of [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${tag} | ${entry.total} | ${entry.failed} |`);
  }
  lines.push("");
  lines.push(`## Human Review`);
  lines.push("");
  lines.push(`Mark each case as pass, borderline, or fail. Deterministic failure does not always mean product failure; it means a strict contract missed.`);

  for (const result of results) {
    const failedChecks = result.checks
      .filter((check) => !check.passed)
      .map((check) => `${check.name}${check.value ? `: ${check.value}` : ""}`);
    lines.push("");
    lines.push(`### ${result.id}`);
    lines.push("");
    lines.push(`Tags: ${result.tags.join(", ")}`);
    lines.push(`Latency: ${result.latency_ms} ms`);
    lines.push(`Deterministic: ${result.deterministic_passed ? "PASS" : "FAIL"}`);
    if (failedChecks.length > 0) lines.push(`Failed checks: ${failedChecks.join("; ")}`);
    lines.push("");
    lines.push(`Input:`);
    lines.push("");
    lines.push("```text");
    lines.push(result.input);
    lines.push("```");
    lines.push("");
    lines.push(`Output:`);
    lines.push("");
    lines.push("```text");
    lines.push(result.output);
    lines.push("```");
    lines.push("");
    lines.push(`Human review: [ ] pass  [ ] borderline  [ ] fail`);
    lines.push("");
    lines.push(`Note:`);
  }

  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let cases = readJsonl(args.dataset);
  if (args.ids) {
    const requested = new Set(args.ids);
    cases = cases.filter((testCase) => requested.has(testCase.id));
    const found = new Set(cases.map((testCase) => testCase.id));
    const missing = [...requested].filter((id) => !found.has(id));
    if (missing.length > 0) {
      throw new Error(`Unknown case id(s): ${missing.join(", ")}`);
    }
  }
  const systemPrompt = strictCleaningPrompt();
  const runId = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  const runDir = path.join(args.outDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const run = {
    id: runId,
    dataset: path.relative(ROOT, args.dataset),
    provider: args.provider,
    base_url: args.baseUrl,
    model: args.model,
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  const results = [];

  for (const testCase of cases) {
    process.stdout.write(`Running ${testCase.id}... `);
    try {
      const response = await sendChatCompletion({
        provider: args.provider,
        baseUrl: args.baseUrl,
        model: args.model,
        systemPrompt,
        input: testCase.input,
      });
      const score = scoreCase(testCase, response.output);
      const result = {
        id: testCase.id,
        tags: testCase.tags,
        input: testCase.input,
        output: response.output,
        raw_output: response.raw,
        latency_ms: response.latencyMs,
        deterministic_passed: score.deterministic_passed,
        checks: score.checks,
        human_review: testCase.human_review || { status: "pending", note: null },
      };
      results.push(result);
      console.log(`${result.deterministic_passed ? "PASS" : "FAIL"} (${result.latency_ms} ms)`);
    } catch (error) {
      const result = {
        id: testCase.id,
        tags: testCase.tags,
        input: testCase.input,
        output: "",
        raw_output: "",
        latency_ms: null,
        deterministic_passed: false,
        checks: [{ name: "runner_error", passed: false, value: error.message }],
        human_review: testCase.human_review || { status: "pending", note: null },
      };
      results.push(result);
      console.log(`ERROR (${error.message})`);
    }
  }

  run.finished_at = new Date().toISOString();
  const payload = { run, results };
  fs.writeFileSync(path.join(runDir, "results.json"), `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(
    path.join(runDir, "results.jsonl"),
    `${results.map((result) => JSON.stringify(result)).join("\n")}\n`,
  );
  fs.writeFileSync(path.join(runDir, "review.md"), reportMarkdown({ run, results }));
  fs.writeFileSync(path.join(args.outDir, "latest-run.txt"), `${runId}\n`);

  const passed = results.filter((result) => result.deterministic_passed).length;
  console.log("");
  console.log(`Wrote ${path.relative(ROOT, runDir)}`);
  console.log(`Deterministic summary: ${passed}/${results.length} passed`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
