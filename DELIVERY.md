# Aedium MIS · delivery (phase 1)

Feature map against the 9 Oct requirements call and the requirements workbook.

| Requirement (call / workbook) | Status | Delivered as |
|---|---|---|
| PO upload → captured automatically (J01, R01–R03) | Built | PO intake agent: any MCP AI reads the PO from Outlook / folder / attachment, `stage_po` runs checks, reviewer approves into the tracker |
| Combined vs separate POs, amendments (R13, R15) | Built | Studio lines per PO; same PO number → amendment v2 with diff; additional / rework → new PO + project number |
| Master tracker summary, billing stages | Built | Excel import into Supabase; PO rows kept on re-import; Cash, Studios, Ask, MCP |
| Design vs construction value, FY billable | Built | **Plan** tab (after Cash): FY outlook vs target, by studio |
| Escalation (10% / yr past end on unbilled) (R12) | Built (estimate) | Plan tab section + Contract watch card + `escalations` tool |
| Monthly projection: week-wise, carry-forward, variance, unplanned, new project (J06, R08–R10) | Built (our version) | Plan tab; auto-fill from pipeline; edit once Melixa's sheet is shared |
| Stage done → Finance → invoice (J03, R06) | Built | Stage pipeline, Invoice trigger agent, **Finance** tab, in-app notifications |
| Zoho Books (J04, R07) | Mimicked | Zoho mirror tables + standalone mock MCP server; Finance invoices/payments write to it |
| Roles / personas | Built | Six roles, server-side checks, persona picker in demo, `user_roles` for real sign-in |
| Email audit (Girish) | Coming soon | **Mail** tab placeholder; Outlook MCP / Microsoft Graph, organisation-wide |
| Excel copy of tracker | Not needed (Aedium keeps the Excel) | Export (.xlsx) + Excel rows for each approved PO |
| Timesheets, rework, multiplier | Phase 2 | Studios placeholders |
| Org structure, owners per milestone | Phase 2 | Staff list imported |
| Client portal | Out of scope | — |
| Platform-agnostic agents | Built | MCP server (29 tools, 7 agent prompts) + Connect AI keys |
| Summaries from rules + LLM | Built | Rule findings; AI wording when `ANTHROPIC_API_KEY` is set |

**Tested:** 47/47 end-to-end checks against live Supabase on 17 Nov 2026 (roles, PO intake incl. failed checks and amendment, stage → finance → invoice → payment, plan, projection, export, role limits). Earlier MCP suite 22/22.

**Open before go-live:** deploy to Vercel; Supabase login (replace demo mode); per-role data trimming; rotate keys shared in chat; Supabase quota warning (restriction from 5 Dec); Aedium's agreement to use real data; Anthropic key for AI wording.

**Waiting on Aedium:** step-by-step SOP and org structure (Melixa), the projection sheet, sample POs for an accuracy test, Zoho connector and access.

## Contents
- `aedium-mis-app/` Next.js app, Supabase migrations, import and test scripts (see its README)
- `zoho-books-mock-mcp/` standalone Zoho Books mock MCP server (test data)
- `DELIVERY.md` this file

Not included on purpose: `node_modules`, build output, `.env.local` (secrets), and the master tracker workbook (real client data).
