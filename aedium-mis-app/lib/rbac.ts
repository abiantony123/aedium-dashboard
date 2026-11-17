// Role-based access: which tabs each persona sees and which actions it may take.
// Enforced on the server (actions, API routes, MCP tools); the UI only hides what a role cannot use.
export const ROLES = ["admin", "ceo", "project_manager", "finance", "hr", "employee"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Planning & MIS (admin)", ceo: "CEO / leadership", project_manager: "Project director",
  finance: "Finance", hr: "HR", employee: "Employee",
};
export const ROLE_NOTE: Record<Role, string> = {
  admin: "Everything, including PO review and API keys.",
  ceo: "All screens; approves agent items and POs.",
  project_manager: "Own studio: stages, contracts, plan.",
  finance: "Finance queue, invoices, payments, collections.",
  hr: "Studios and people view (timesheets in phase 2).",
  employee: "Studio view and mail (my work in phase 2).",
};

export const TABS = ["brief", "cash", "plan", "finance", "agents", "ask", "studios", "mail", "connect"] as const;
export type TabName = (typeof TABS)[number];

const TAB_ACCESS: Record<Role, TabName[]> = {
  admin: [...TABS],
  ceo: [...TABS],
  project_manager: ["brief", "cash", "plan", "agents", "ask", "studios", "mail", "connect"],
  finance: ["brief", "cash", "plan", "finance", "agents", "ask", "mail", "connect"],
  hr: ["brief", "studios", "ask", "mail"],
  employee: ["studios", "mail"],
};

export type Action =
  | "stage.complete" | "stage.approve" | "stage.notify_finance"
  | "finance.invoice" | "finance.payment"
  | "agent.collections" | "agent.invoice_trigger" | "agent.contract_watch"
  | "po.stage" | "po.review"
  | "plan.target" | "plan.projection"
  | "keys.manage" | "data.read";

const ACTIONS: Record<Role, Action[]> = {
  admin: ["stage.complete", "stage.approve", "stage.notify_finance", "finance.invoice", "finance.payment", "agent.collections", "agent.invoice_trigger", "agent.contract_watch", "po.stage", "po.review", "plan.target", "plan.projection", "keys.manage", "data.read"],
  ceo: ["stage.complete", "stage.approve", "stage.notify_finance", "agent.collections", "agent.invoice_trigger", "agent.contract_watch", "po.stage", "po.review", "plan.target", "plan.projection", "keys.manage", "data.read"],
  project_manager: ["stage.complete", "stage.approve", "stage.notify_finance", "agent.invoice_trigger", "agent.contract_watch", "po.stage", "plan.projection", "keys.manage", "data.read"],
  finance: ["finance.invoice", "finance.payment", "agent.collections", "plan.projection", "keys.manage", "data.read"],
  hr: ["data.read"],
  employee: [],
};

export const canSee = (role: Role, tab: TabName) => TAB_ACCESS[role].includes(tab);
export const tabsFor = (role: Role) => TAB_ACCESS[role];
export const can = (role: Role, action: Action) => ACTIONS[role].includes(action);
export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as readonly string[]).includes(x);

export class Forbidden extends Error {
  constructor(role: Role, action: Action) { super(`${ROLE_LABEL[role]} cannot ${action.replace(".", ": ").replace("_", " ")}.`); }
}
export function assertCan(role: Role, action: Action) { if (!can(role, action)) throw new Forbidden(role, action); }
