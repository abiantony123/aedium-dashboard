# Answer key — synthetic test POs TP06–TP11

All companies are fictional. Values are INR **excluding GST**; percentages as 0–1 in the MIS.
Score a clean PO by counting fields: header fields + one per line (studio, value) + one per stage (text, %). 95% = at most 1 wrong field in 20.

## Clean POs (target ≥ 95% field accuracy, all checks pass)

### TP06 — Indigo Crest Hospitals Pvt Ltd
| Field | Expected |
|---|---|
| po_number | ICH/PO/2026/0912 |
| client_name | Indigo Crest Hospitals Pvt Ltd |
| project_name | Indigo Crest Multispecialty Hospital |
| location | Electronic City, Bengaluru |
| project_type | Hospital |
| po_date | 2026-11-20 |
| start_date / end_date | 2026-12-01 / 2029-11-30 |
| contract_validity | 36 months from start date |
| escalation_clause | 10% per annum on the unbilled fee after the end date |
| total_value | 15000000 |
| gst_included | false |
| lines | Healthcare 12000000 (0.8); Healthcare Interior 3000000 (0.2) |
| stages — Healthcare | Advance on signing of PO 0.10 · Concept design / DBR 0.10 · Schematic design 0.15 · Design development 0.15 · Tender drawings and BOQ 0.10 · GFC drawings 0.20 · Construction stage 0.20 (is_construction, 24 instalments) |
| stages — Healthcare Interior | Advance on signing of PO 0.10 · Concept design 0.15 · Design development 0.20 · Tender drawings and BOQ 0.15 · GFC drawings 0.25 · Construction stage 0.15 (is_construction, 12 instalments) |
| kind / match | new / new project |

### TP07 — Riverbend Logistics Parks Pvt Ltd
| Field | Expected |
|---|---|
| po_number | RLP-WO-2611-044 |
| client_name | Riverbend Logistics Parks Pvt Ltd |
| project_name | Riverbend Warehousing Park |
| location | Hoskote, Bengaluru |
| project_type | Industrial |
| po_date | 2026-11-22 |
| start_date / end_date | 2026-12-01 / 2028-05-31 |
| contract_validity | 18 months |
| escalation_clause | Price firm; no escalation |
| total_value | 3600000 |
| lines | Arch - Com 3600000 (1.0) |
| stages — Arch - Com | Advance on signing of work order 0.10 · Concept design approval 0.20 · Design development 0.20 · Tender drawings and BOQ 0.15 · GFC drawings 0.20 · Construction stage 0.15 (is_construction, 6 instalments) |
| kind / match | new / new project |

### TP08 — Maple Grove Homes LLP
| Field | Expected |
|---|---|
| po_number | MGH/2026/PO/317 |
| client_name | Maple Grove Homes LLP |
| project_name | Maple Grove Residences |
| location | Sarjapur Road, Bengaluru |
| project_type | Residential - High rise |
| po_date | 2026-11-24 |
| start_date / end_date | 2026-12-01 / 2029-05-31 |
| contract_validity | 30 months from start date |
| escalation_clause | 10% per annum on the unbilled fee after the end date |
| total_value | 10000000 |
| lines | Arch - Resi 6000000 (0.6); Structural 2500000 (0.25); MEPF 1500000 (0.15) |
| stages — each of the 3 studios | Advance on signing of PO 0.10 · Concept design 0.10 · Schematic design 0.15 · Sanction drawings 0.05 · Design development and tender drawings 0.20 · GFC drawings 0.20 · Construction stage 0.20 (is_construction, 18 instalments) |
| kind / match | new / new project |

### TP11 — Orchid Bay Hotels Pvt Ltd
| Field | Expected |
|---|---|
| po_number | OBH-PO-26-1188 |
| client_name | Orchid Bay Hotels Pvt Ltd |
| project_name | Orchid Bay Resort |
| location | Gokarna, Karnataka |
| project_type | Hospitality |
| po_date | 2026-11-25 |
| start_date / end_date | 2026-12-01 / 2028-11-30 |
| contract_validity | 24 months |
| escalation_clause | Price firm; no escalation |
| total_value | 4200000 (**not** 4956000 — that includes GST) |
| lines | Landscape 4200000 (1.0) |
| stages — Landscape (fees printed, % derived) | Appointment 0.10 (420000) · Concept design 0.15 (630000) · Design development 0.20 (840000) · Tender drawings and BOQ 0.15 (630000) · GFC drawings (hardscape and softscape) 0.20 (840000) · Construction stage 0.20 (840000; is_construction, 6 instalments) |
| kind / match | new / new project |

## Edge cases (judged on the decision, not field accuracy)

### TP09 — Northwind additional area (NWR/PO/2026/0163)
- Staged as **additional** (kind `additional`), not an amendment: new PO number, same client and site, scope says additional built-up area.
- Lines: Arch - Com 1400000, Structural 400000; total 1800000.
- Stages taken from TP01's Annexure A (10 / 15 / 20 / 15 / 25 / 15, construction 12 instalments), with a note saying where they came from.
- Note: linked to the Northwind Tech Park Phase 2 project; Finance assigns a new project number (BR12). No project number invented.

### TP10 — Tidewater, no split (TIP/PO/2026/0450)
- Staged with total 8000000 and the common stage table (10 / 15 / 20 / 15 / 25 / 15).
- The split across Architecture / MEPF / Landscape is **not** in the PO: the agent must not invent one. Expect the split check to fail (or a single line with a note) and a review note asking BD to confirm the split.
