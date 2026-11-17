# Zoho Books mock MCP (test only)

A read-only stand-in for the Zoho MCP server, with **synthetic** data (fictional clients, made-up numbers), so the Aedium agents can be built and tested before Aedium connects real Zoho Books.

Responses use the Zoho Books API v3 shape (`{ code, message, invoices: [...], page_context }`), so prompts written against the mock should carry over to the real connector.

## Tools (all read-only)

| Tool | Used by agent |
|---|---|
| `get_organization` | all (currency, fiscal year, as-of date) |
| `list_contacts`, `get_contact` | Work-order extraction (match client) |
| `list_sales_orders`, `get_sales_order` | Invoice trigger (PO → SO → invoices) |
| `list_invoices`, `get_invoice` | Invoice trigger (stage matching), Collections |
| `list_customer_payments` | Collections (collected, TDS) |
| `get_receivables_aging` | Collections, Brief / Cash screens |

No create/update/delete tools, the same as the read-only access planned for the real Zoho connection.

## Run

```bash
npm install
npm run smoke
```

- `MOCK_TODAY` (default `2026-10-19`) is the "as of" date for overdue maths, set to match the designs.
- `MOCK_DATA` points at another seed file. `data/seed.json` is re-read on every call, so you can edit it while Claude is connected.

## Seed totals (as of 2026-10-19)

8 open invoices · ₹1.73 Cr outstanding · ₹1.56 Cr late · ₹1.46 Cr in the 90+ bucket (4 invoices on Meridian Gateway) · ₹16.7 L billed in October · ₹9.36 L collected in October net of TDS.

## Connect

- **Claude Code:** `.mcp.json` in the `tracker` folder registers it. Approve the server when prompted.
- **Claude Desktop:** add the same `zoho-books-mock` block under `mcpServers` in `%APPDATA%\Claude\claude_desktop_config.json`, then restart Claude Desktop.

## Swapping to real Zoho

Replace this server with the Zoho MCP endpoint (India data centre, read-only Zoho Books scopes for invoices, customer payments, sales orders and contacts). Tool names in the real server will differ, so map them in the agent skills.
