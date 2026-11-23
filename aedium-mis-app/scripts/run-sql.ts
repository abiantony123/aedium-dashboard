// npx tsx scripts/run-sql.ts <file.sql> — run a SQL file on the project through the Supabase Management API.
import { config } from "dotenv"; import { readFileSync } from "node:fs"; config({ path: ".env.local", quiet: true });
const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST", headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: readFileSync(process.argv[2], "utf8") }),
});
console.log(res.status, (await res.text()).slice(0, 800));
