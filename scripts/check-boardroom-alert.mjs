// WBR-373 alert gate (Developer 80): runs scripts/sql/boardroom-alert-probe.sql
// against production through the Supabase Management API. The probe calls
// boardroom_alert as an admin (five metric rows) and as a non-admin (refused),
// reads the grants back, and always rolls back. Needs SUPABASE_ACCESS_TOKEN;
// without it the gate says so as a credential skip rather than passing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = process.env.BOARDROOM_SUPABASE_PROJECT || "zdtkwpzdwnzzmdwrvmka";
const token = process.env.SUPABASE_ACCESS_TOKEN;

if (!token) {
  console.log("SKIP boardroom alert: SUPABASE_ACCESS_TOKEN credential not configured on this host");
  process.exit(0);
}

const sql = readFileSync(path.join(root, "scripts/sql/boardroom-alert-probe.sql"), "utf8");
const res = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: sql }),
});
const text = await res.text();
const result = parseProbe(text);

if (result && result.ok === true && result.anonCanExecute === false && result.securityDefiner === true) {
  console.log(`PASS boardroom alert: admin sees ${result.adminRows} metrics (${result.adminMetrics}); non-admin refused (${result.memberError}); anon cannot execute; rolled back`);
} else {
  console.log(`FAIL boardroom alert: ${result ? JSON.stringify(result) : `no probe result (HTTP ${res.status}) ${text.slice(0, 400)}`}`);
  process.exitCode = 1;
}

// The probe reports by raising, so its result arrives inside the API's error
// message: take everything after PROBE_RESULT up to the CONTEXT line.
export function parseProbe(body) {
  let message = body;
  try {
    const parsed = JSON.parse(body);
    message = parsed?.message ?? parsed?.error?.message ?? body;
  } catch { /* plain text */ }
  const start = message.indexOf("PROBE_RESULT ");
  if (start < 0) return null;
  const rest = message.slice(start + "PROBE_RESULT ".length);
  const end = rest.search(/\nCONTEXT:|$/);
  try { return JSON.parse(rest.slice(0, end).trim()); } catch { return null; }
}
