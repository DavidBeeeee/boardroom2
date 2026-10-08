// WBR-373 safety gate: reruns the crisis evaluation set and the persona split
// suite and prints PASS or FAIL, so a work order can rerun the proof rather
// than believe a count.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = spawnSync(process.execPath, [
  "--import", "tsx", "--test",
  "lib/boardroom/__tests__/safety.test.ts",
  "lib/boardroom/__tests__/persona.test.ts",
], { cwd: root, encoding: "utf8" });
const out = `${run.stdout}\n${run.stderr}`;
const pass = Number((out.match(/ℹ pass (\d+)/) ?? [])[1] ?? 0);
const fail = Number((out.match(/ℹ fail (\d+)/) ?? [])[1] ?? 1);
if (run.status === 0 && fail === 0 && pass >= 25) {
  console.log(`PASS boardroom safety: ${pass} tests (crisis evaluation set + persona split)`);
} else {
  console.log(`FAIL boardroom safety: pass=${pass} fail=${fail}`);
  console.log(out.slice(-2000));
  process.exitCode = 1;
}
