// WBR-373 injection gate (Developer 97): reruns the prompt-injection evaluation
// set and the burst rate-limit suite with DeepSeek stubbed and prints PASS or
// FAIL. Pinned to the spec reporter so the counts read the same whether or not
// stdout is a terminal.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(process.execPath, [
  "--import", "tsx", "--test", "--test-reporter=spec",
  "lib/boardroom/__tests__/injection.test.ts",
  "lib/boardroom/__tests__/ratelimit.test.ts",
], { cwd: root, encoding: "utf8" });
const out = `${run.stdout}\n${run.stderr}`;
const pass = Number((out.match(/ℹ pass (\d+)/) ?? [])[1] ?? 0);
const fail = Number((out.match(/ℹ fail (\d+)/) ?? [])[1] ?? 1);
const chat = (out.match(/✔ chat injection contained/g) ?? []).length;
const docs = (out.match(/✔ document injection contained/g) ?? []).length;
const lookAlikes = /✔ ordinary look-alikes never trip/.test(out);
if (run.status === 0 && fail === 0 && chat >= 4 && docs >= 4 && lookAlikes && pass >= 16) {
  console.log(`PASS boardroom injection: ${pass} tests (${chat} chat and ${docs} document injections contained and logged without member text, look-alikes untouched, rate limit)`);
} else {
  console.log(`FAIL boardroom injection: pass=${pass} fail=${fail} chat=${chat} documents=${docs} lookAlikes=${lookAlikes}`);
  console.log(out.slice(-2000));
  process.exitCode = 1;
}
