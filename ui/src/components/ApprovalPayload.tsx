import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatCents } from "../lib/utils";

export const typeLabel: Record<string, string> = {
  hire_agent: "Hire Agent",
  approve_ceo_strategy: "CEO Strategy",
  budget_override_required: "Budget Override",
  request_board_approval: "Board Approval",
};

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

export function approvalSubject(payload?: Record<string, unknown> | null): string | null {
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

/**
 * Decision-critical metadata for the approval decision card (OXFA-2799). Every
 * field is optional and reads defensively from the freeform payload plus the
 * approval's own top-level columns, so the card degrades cleanly when a source
 * (e.g. an older approval with no gate/risk) is absent.
 */
export interface ApprovalMeta {
  /** Normalised gate label: "A", "B", or a free-text gate name. */
  gate: string | null;
  /** Normalised risk: "low" | "medium" | "high", or a free-text level. */
  risk: string | null;
  /** SLA descriptor, e.g. "24h SLA". */
  slaLabel: string | null;
  /** ISO deadline string if the payload carries one. */
  deadline: string | null;
  requestedByAgentId: string | null;
  /** ISO request timestamp. */
  requestedAt: string | null;
  /** ISO decision timestamp, once decided. */
  decidedAt: string | null;
}

export interface ApprovalMetaSource {
  payload?: Record<string, unknown> | null;
  requestedByAgentId?: string | null;
  createdAt?: string | Date | null;
  decidedAt?: string | Date | null;
}

function normalizeGate(value: unknown): string | null {
  const raw = firstNonEmptyString(value);
  if (!raw) return null;
  const match = raw.match(/gate[\s_-]*([ab])\b/i) ?? raw.match(/^([ab])$/i);
  return match ? match[1].toUpperCase() : raw;
}

function normalizeRisk(value: unknown): string | null {
  const raw = firstNonEmptyString(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes("high") || lower.includes("critical")) return "high";
  if (lower.includes("med") || lower.includes("moderate")) return "medium";
  if (lower.includes("low")) return "low";
  return raw;
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** Extract at-a-glance metadata from an approval, degrading cleanly on missing fields. */
export function extractApprovalMeta(source: ApprovalMetaSource): ApprovalMeta {
  const payload = source.payload ?? {};
  const slaHours = typeof payload.slaHours === "number" ? `${payload.slaHours}h SLA` : null;
  return {
    gate: normalizeGate(payload.gate ?? payload.gateType ?? payload.gateLevel),
    risk: normalizeRisk(payload.risk ?? payload.riskLevel ?? payload.severity),
    slaLabel: firstNonEmptyString(payload.sla, payload.slaTarget, slaHours),
    deadline: toIsoOrNull(payload.deadline ?? payload.dueAt ?? payload.slaDueAt ?? payload.dueBy),
    requestedByAgentId:
      firstNonEmptyString(source.requestedByAgentId, payload.requestedByAgentId) ?? null,
    requestedAt: toIsoOrNull(source.createdAt),
    decidedAt: toIsoOrNull(source.decidedAt),
  };
}

const GATE_TONE: Record<string, string> = {
  A: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  B: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

/** Gate badge; renders nothing when the gate is unknown. */
export function GateBadge({ gate }: { gate: string | null }) {
  if (!gate) return null;
  const tone = GATE_TONE[gate] ?? "border-border/70 bg-background/70 text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-label) ${tone}`}
    >
      Gate {gate}
    </span>
  );
}

const RISK_TONE: Record<string, string> = {
  high: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
};

/** Risk badge; renders nothing when risk is unknown. */
export function RiskBadge({ risk }: { risk: string | null }) {
  if (!risk) return null;
  const tone = RISK_TONE[risk] ?? "border-border/70 bg-background/70 text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-(length:--text-micro) font-semibold uppercase tracking-(--tracking-label) ${tone}`}
    >
      {risk} risk
    </span>
  );
}

/**
 * An approval is an email reply when it carries a customer-facing body plus at least
 * one email envelope field. Kept cheap and false-positive-safe so unrelated board
 * approvals continue to render through BoardApprovalPayload untouched.
 */
export function isEmailReplyPayload(payload?: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const hasBody = typeof payload.body === "string" && payload.body.trim().length > 0;
  const hasEnvelope =
    typeof payload.subject === "string" ||
    typeof payload.recipient === "string" ||
    typeof payload.channel === "string";
  return hasBody && hasEnvelope;
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload);
  if (subject) {
    return `${base}: ${subject}`;
  }
  return base;
}

export const typeIcon: Record<string, typeof UserPlus> = {
  hire_agent: UserPlus,
  approve_ceo_strategy: Lightbulb,
  budget_override_required: ShieldAlert,
  request_board_approval: ShieldCheck,
};

export const defaultTypeIcon = ShieldCheck;

function PayloadField({ label, value }: { label: string; value: unknown }) {
  if (!value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">{label}</span>
      <span>{String(value)}</span>
    </div>
  );
}

function SkillList({ values }: { values: unknown }) {
  if (!Array.isArray(values)) return null;
  const items = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
  if (items.length === 0) return null;

  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Skills</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

export function HireAgentPayload({ payload }: { payload: Record<string, unknown> }) {
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Name</span>
        <span className="font-medium">{String(payload.name ?? "—")}</span>
      </div>
      <PayloadField label="Role" value={payload.role} />
      <PayloadField label="Title" value={payload.title} />
      <PayloadField label="Icon" value={payload.icon} />
      {!!payload.capabilities && (
        <div className="flex items-start gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs pt-0.5">Capabilities</span>
          <span className="text-muted-foreground">{String(payload.capabilities)}</span>
        </div>
      )}
      {!!payload.adapterType && (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-20 sm:w-24 shrink-0 text-xs">Adapter</span>
          <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
            {String(payload.adapterType)}
          </span>
        </div>
      )}
      <SkillList values={payload.desiredSkills} />
    </div>
  );
}

export function CeoStrategyPayload({ payload }: { payload: Record<string, unknown> }) {
  const plan = payload.plan ?? payload.description ?? payload.strategy ?? payload.text;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {!!plan && (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap font-mono text-xs max-h-48 overflow-y-auto">
          {String(plan)}
        </div>
      )}
      {!plan && (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground overflow-x-auto max-h-48">
          {JSON.stringify(payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function BudgetOverridePayload({ payload }: { payload: Record<string, unknown> }) {
  const budgetAmount = typeof payload.budgetAmount === "number" ? payload.budgetAmount : null;
  const observedAmount = typeof payload.observedAmount === "number" ? payload.observedAmount : null;
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Scope" value={payload.scopeName ?? payload.scopeType} />
      <PayloadField label="Window" value={payload.windowKind} />
      <PayloadField label="Metric" value={payload.metric} />
      {(budgetAmount !== null || observedAmount !== null) ? (
        <div className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Limit {budgetAmount !== null ? formatCents(budgetAmount) : "—"} · Observed {observedAmount !== null ? formatCents(observedAmount) : "—"}
        </div>
      ) : null}
      {!!payload.guidance && (
        <p className="text-muted-foreground">{String(payload.guidance)}</p>
      )}
    </div>
  );
}

export function BoardApprovalPayload({
  payload,
  hideTitle = false,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} />
  );
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const nextActionOnApproval = firstNonEmptyString(payload.nextActionOnApproval);
  const proposedComment = firstNonEmptyString(payload.proposedComment);

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      {title && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Title</p>
          <p className="font-medium leading-6 text-foreground">{title}</p>
        </div>
      )}
      {summary && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Summary</p>
          <p className="leading-6 text-foreground/90">{summary}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {nextActionOnApproval && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">On approval</p>
          <p className="mt-1 leading-6 text-foreground">{nextActionOnApproval}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Proposed comment
          </p>
          <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap">
            {proposedComment}
          </pre>
        </div>
      )}
    </div>
  );
}

function EmailHeaderRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-16 shrink-0 pt-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 break-words leading-6 text-foreground/90">{value}</span>
    </div>
  );
}

/**
 * Renders an email-reply approval as the customer will receive it — an envelope header
 * over the body as prose — with the agent's reasoning kept beneath so the board can
 * scope the request without opening the raw payload.
 */
export function EmailReplyPayload({ payload }: { payload: Record<string, unknown> }) {
  const channel = firstNonEmptyString(payload.channel);
  const recipient = firstNonEmptyString(payload.recipient);
  const subject = firstNonEmptyString(payload.subject);
  const orderRef = firstNonEmptyString(payload.threadOrOrderRef);
  const gate = firstNonEmptyString(payload.gate);
  const body = firstNonEmptyString(payload.body) ?? "";
  const intent = firstNonEmptyString(payload.intent);
  const recommendedAction = firstNonEmptyString(payload.recommendedAction);
  const risks = Array.isArray(payload.risks)
    ? payload.risks
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];

  return (
    <div className="mt-4 space-y-3.5 text-sm">
      <div className="overflow-hidden rounded-lg border border-border/60 bg-background/60">
        <div className="space-y-1 border-b border-border/60 bg-muted/30 px-3.5 py-2.5">
          {channel && <EmailHeaderRow label="From" value={channel} />}
          {recipient && <EmailHeaderRow label="To" value={recipient} />}
          {subject && <EmailHeaderRow label="Subject" value={subject} />}
          {orderRef && <EmailHeaderRow label="Ref" value={orderRef} />}
          {gate && (
            <div className="flex gap-2">
              <span className="w-16 shrink-0 pt-0.5 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Gate
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground">
                {gate}
              </span>
            </div>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto whitespace-pre-wrap px-4 py-3.5 leading-6 text-foreground">
          {body}
        </div>
      </div>

      {intent && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Intent</p>
          <p className="leading-6 text-foreground/90">{intent}</p>
        </div>
      )}
      {recommendedAction && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{recommendedAction}</p>
        </div>
      )}
      {risks.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Risks</p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {risks.map((risk) => (
              <li key={risk} className="flex items-start gap-2">
                <span className="mt-2 h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                <span className="leading-6">{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ApprovalPayloadRenderer({
  type,
  payload,
  hidePrimaryTitle = false,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    if (isEmailReplyPayload(payload)) return <EmailReplyPayload payload={payload} />;
    return <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} />;
  }
  return <CeoStrategyPayload payload={payload} />;
}
