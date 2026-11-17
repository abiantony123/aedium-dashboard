# Aedium MIS

Order book, billing, collections and agents for Aedium Design: the master tracker and a Zoho Books mirror in Supabase, a Next.js dashboard on Vercel, and an MCP server so Claude, ChatGPT or Gemini can work with the same data and agents.

## What is in it

| Area | Where | Notes |
|---|---|---|
| **Brief** | tab | KPIs, rule findings worded by AI (rule text without a key), three decisions, data confidence |
| **Cash** | tab | Stage-to-cash pipeline, invoiced/collected, project timeline, receivables ageing, *Mark stage complete* |
| **Plan** | tab | FY outlook vs target (billed + design pending + construction instalments before 31 March), by studio; monthly projection (week 1-5 forecast vs actual, carry-forward, unplanned / new-project); escalation estimates |
| **Finance** | tab | Stages sent to Finance, *Raise invoice*, open invoices, *Record payment* (Zoho Books mirror) |
| **Agents** | tab | Collections, Invoice trigger, Contract watch, PO extraction; approve / dismiss / draft; **PO intake** review queue |
| **Ask** | tab | Claude answers from read-only tools (needs `ANTHROPIC_API_KEY`) |
| **Studios** | tab | Contract value by studio, studio revenue, committed forecast; multiplier needs payroll (phase 2) |
| **Mail** | tab | Coming soon: organisation-wide client email per project via Outlook MCP / Microsoft Graph |
| **Connect AI** | plug icon | API keys (inherit your role), setup for claude.ai, ChatGPT, Claude desktop / Code, Gemini CLI, Cursor / VS Code, call log |
| **Export** | download icon | Tracker as .xlsx in the master tracker layout (Summary, Billing Stages, Purchase orders) |
| **MCP server** | `/api/mcp` | 29 tools, 7 agent prompts, Streamable HTTP, API key auth |

### Roles

| Role | Tabs | Can |
|---|---|---|
| Planning & MIS (admin) | all | everything, PO review, targets, keys |
| CEO / leadership | all | stages, agent approvals, PO review, targets, keys |
| Project director | Brief, Cash, Plan, Agents, Ask, Studios, Mail | stages and agents **for their studio only**, projection rows, keys |
| Finance | Brief, Cash, Plan, Finance, Agents, Ask, Mail | invoices, payments, collections, projection rows, keys |
| HR | Brief, Studios, Ask, Mail | read |
| Employee | Studios, Mail | view only (my work arrives with timesheets, phase 2) |

Every action is checked on the server (dashboard actions, Ask, export, MCP tools). API keys act with their creator's role and studio.

### PO intake (any AI)

1. Connect the AI on **Connect AI** with a *read and act* key.
2. Ask it, e.g. *"Read the PO attached to the latest mail from the client and stage it for Aedium"* or *"Run the Aedium po_intake agent on C:\POs\BVM-phase2.pdf"*. The AI reads the PO with its own Outlook / file access, calls `get_po_schema`, then `stage_po`.
3. The server checks: studio split = PO value, stage % = 100% per studio, fees = % × value, known studio names, project number, dates, confidence. An existing PO number is staged as an **amendment** with a field-by-field diff.
4. A reviewer approves on **Agents → PO intake** (or `review_po`). Approval merges into the tracker (new lines/stages, or updated values for an amendment; billed stages are never changed). Failed checks need a review note.
5. The Excel: the AI calls `tracker_rows_for_excel` and appends the rows if it can write the workbook; otherwise use **Excel rows** (copy) or **Export**. Re-importing the Excel keeps PO-created rows.

## Setup

### 1. Supabase
1. Run the SQL files in `supabase/migrations` **in order** in the SQL Editor.
2. Project Settings → Data API → **Exposed schemas**: add `mis`.
3. For real sign-in: Authentication → disable public sign-ups, invite users, add `https://<domain>/auth/callback` to Redirect URLs, and add rows to `mis.user_roles` (`email, role, studio`).

### 2. Load the tracker (your machine)
```bash
cp .env.example .env.local
```
```bash
npm install
```
```bash
npm run import -- --dry-run
```
```bash
npm run import -- --with-zoho
```
`--with-zoho` also loads the sample Zoho Books data (first time only; later imports keep invoices and payments recorded in the app). `--file` picks another workbook.

### 3. Vercel
Import the repo, set the variables from `.env.example` (`SUPABASE_SERVICE_ROLE_KEY` as a normal server variable), deploy. Keep `DEMO_MODE=1` for the persona demo; clear it for real sign-in.

### Checks
```bash
npm run typecheck
```
```bash
npm run e2e
```
`e2e` needs `npm run dev` on port 3005 with `DEMO_MODE=1`; it runs 47 checks (roles, PO intake + amendment, stage → finance → invoice → payment, plan, export) and deletes what it creates.

## Known limits
- **Zoho Books** is a mirror with sample data plus what Finance records in the app. Swap in the real Zoho MCP (read-only invoices, payments, sales orders, contacts) when Aedium approves access.
- **Role data scope:** tabs and actions are enforced server-side, but the dashboard page still sends shared summary figures to every role that sees Brief/Cash; trim per-role payloads before real users with restricted roles go live.
- **Timesheets, payroll, org structure, email**: phase 2 / coming soon.
- Construction instalment and escalation figures are estimates from the tracker and clause text; confirm against the PO.
- The tracker contains real client data: treat Supabase, exports and API keys as confidential.
