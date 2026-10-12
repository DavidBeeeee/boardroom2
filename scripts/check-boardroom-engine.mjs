// WBR-373 engine gate (Developer 45, 51 to 57): reruns the engine evaluation
// set and the invented-progress cases with DeepSeek stubbed, and proves no
// network call happened, so a work order can rerun the proof rather than
// believe a count.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suite = "lib/boardroom/__tests__/engine-eval.test.ts";
const source = readFileSync(path.join(root, suite), "utf8");
const problems = [];
if (/from\s+["']\.\.\/deepseek/.test(source)) problems.push("the suite imports deepseek.ts directly");
if (!/setLlmTransportForTests\(/.test(source)) problems.push("the suite does not stub the DeepSeek transport");

const { cases, claims } = JSON.parse(readFileSync(path.join(root, "lib/boardroom/__tests__/engine-cases.json"), "utf8"));
const kinds = ["vague", "broad", "hard_to_measure", "conflicting", "concept_distinction", "filler", "unusual"];
for (const kind of kinds) if (cases.filter(c => c.kind === kind).length < 2) problems.push(`fewer than two ${kind} cases`);

const run = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", suite], {
  cwd: root, encoding: "utf8", env: { ...process.env, DEEPSEEK_API_KEY: "" },
});
const out = `${run.stdout}\n${run.stderr}`;
const pass = Number((out.match(/ℹ pass (\d+)/) ?? [])[1] ?? 0);
const fail = Number((out.match(/ℹ fail (\d+)/) ?? [])[1] ?? 1);
const networkProof = /✔ zero network calls to DeepSeek/.test(out);
if (!networkProof) problems.push("the zero-network-call test did not pass");

if (run.status === 0 && fail === 0 && pass >= cases.length + claims.length && !problems.length) {
  console.log(`PASS boardroom engine: ${pass} tests (${cases.length} engine cases, ${claims.length} invented-progress cases, zero DeepSeek network calls)`);
} else {
  console.log(`FAIL boardroom engine: pass=${pass} fail=${fail}${problems.length ? ` (${problems.join("; ")})` : ""}`);
  console.log(out.slice(-2000));
  process.exitCode = 1;
}
