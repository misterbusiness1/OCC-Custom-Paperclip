import { useState } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "./MarkdownBody";
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

function uniqueStrings(...values: unknown[]): string[] {
  const items = values.flatMap((value) => (Array.isArray(value) ? value : [value]));
  const seen = new Set<string>();

  return items.flatMap((value) => {
    if (typeof value !== "string") return [];
    const item = value.trim();
    const key = item.toLocaleLowerCase();
    if (!item || seen.has(key)) return [];
    seen.add(key);
    return [item];
  });
}

export function approvalDecisionBrief(payload?: Record<string, unknown> | null) {
  return {
    recommendation: firstNonEmptyString(
      payload?.recommendedAction,
      payload?.recommendation,
      payload?.proposedAction,
    ),
    reasoning: firstNonEmptyString(
      payload?.reasoning,
      payload?.rationale,
      payload?.justification,
      payload?.decisionReasoning,
      payload?.summary,
      payload?.intent,
      payload?.guidance,
      payload?.description,
      payload?.strategy,
      payload?.plan,
      payload?.capabilities,
    ),
    pros: uniqueStrings(
      payload?.pros,
      payload?.benefits,
      payload?.reasonsToApprove,
      payload?.advantages,
      payload?.upside,
    ),
    cons: uniqueStrings(
      payload?.cons,
      payload?.risks,
      payload?.riskAssessment,
      payload?.brandRiskAssessment,
      payload?.reasonsNotToApprove,
      payload?.tradeoffs,
      payload?.drawbacks,
      payload?.downside,
    ),
    nextAction: firstNonEmptyString(payload?.nextActionOnApproval),
  };
}

export type ApprovalOriginalRequest = {
  text: string;
  source: {
    kind: "paperclip_comment" | "external";
    commentId?: string;
    issueId?: string;
    sender?: string;
    sentAt?: string;
    reference?: string;
    channel?: string;
    snapshotOrigin?: "server" | "requester";
  };
};

export function approvalOriginalRequest(
  payload?: Record<string, unknown> | null,
): ApprovalOriginalRequest | null {
  const value = payload?.originalRequest;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (typeof record.text !== "string" || record.text.length === 0) return null;
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.kind !== "paperclip_comment" && sourceRecord.kind !== "external") {
    return null;
  }
  const optionalString = (key: string) =>
    typeof sourceRecord[key] === "string" && sourceRecord[key] ? String(sourceRecord[key]) : undefined;
  return {
    text: record.text,
    source: {
      kind: sourceRecord.kind,
      commentId: optionalString("commentId"),
      issueId: optionalString("issueId"),
      sender: optionalString("sender"),
      sentAt: optionalString("sentAt"),
      reference: optionalString("reference"),
      channel: optionalString("channel"),
      snapshotOrigin:
        sourceRecord.snapshotOrigin === "server"
          ? "server"
          : sourceRecord.snapshotOrigin === "requester"
            ? "requester"
            : undefined,
    },
  };
}

export function OriginalRequestBlock({
  payload,
  compact = false,
}: {
  payload?: Record<string, unknown> | null;
  compact?: boolean;
}) {
  const original = approvalOriginalRequest(payload);
  if (!original) {
    // Compact surfaces state this once in their header line (approvalMissingSourceNote).
    if (compact) return null;
    return (
      <div>
        <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
          Original request
        </p>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          No original request was attached to this approval.
        </p>
      </div>
    );
  }

  const commentHref =
    original.source.kind === "paperclip_comment" && original.source.issueId && original.source.commentId
      ? `/issues/${original.source.issueId}#comment-${original.source.commentId}`
      : null;
  const provenance = [
    original.source.kind === "external" ? original.source.channel : null,
    original.source.sender,
    original.source.sentAt ? new Date(original.source.sentAt).toLocaleString() : null,
    // The comment link below replaces the raw comment reference.
    commentHref ? null : original.source.reference,
  ]
    .filter(Boolean)
    .join(" · ");
  const sourceNote =
    original.source.kind === "external" && original.source.snapshotOrigin === "requester"
      ? "Requester-provided external source snapshot"
      : original.source.kind === "paperclip_comment" && original.source.snapshotOrigin === "server"
        ? "Paperclip source snapshot"
        : null;

  return (
    <div>
      <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        Original request
      </p>
      {(provenance || sourceNote || commentHref) && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {[provenance, sourceNote].filter(Boolean).join(" · ")}
          {commentHref && (
            <>
              {provenance || sourceNote ? " · " : ""}
              <Link to={commentHref} className="underline underline-offset-2 hover:text-foreground">
                View comment
              </Link>
            </>
          )}
        </p>
      )}
      <OriginalRequestText text={original.text} collapsible={compact && isLongOriginalRequest(original.text)} />
    </div>
  );
}

const ORIGINAL_REQUEST_PREVIEW_LENGTH = 480;
const ORIGINAL_REQUEST_PREVIEW_LINES = 16;

/** A request this long is previewed on compact surfaces, behind a button that states its size. */
function isLongOriginalRequest(text: string) {
  if (text.length > ORIGINAL_REQUEST_PREVIEW_LENGTH) return true;
  let lines = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
    if (lines > ORIGINAL_REQUEST_PREVIEW_LINES) return true;
  }
  return false;
}

function OriginalRequestText({ text, collapsible }: { text: string; collapsible: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clamped = collapsible && !expanded;

  return (
    <>
      <div className="mt-2 rounded-md bg-muted/40 p-3">
        {/* Shown whole or behind the announced preview: never in a box that scrolls its end out of sight. */}
        <pre
          className={cn(
            "whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-foreground",
            clamped && "line-clamp-4",
          )}
        >
          {text}
        </pre>
      </div>
      {collapsible && (
        <button
          type="button"
          className="mt-1 inline-flex min-h-6 items-center text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show full request (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </>
  );
}

/**
 * A Board approval may answer a request from a person, or the agent may raise
 * it by itself. Without an attached source the board should know that, but one
 * quiet note is enough: it is the normal case for routine agent requests.
 */
export function approvalMissingSourceNote(
  type: string,
  payload?: Record<string, unknown> | null,
): string | null {
  if (type !== "request_board_approval" || approvalOriginalRequest(payload)) return null;
  return "No original request attached";
}

export type ApprovalHireFacts = {
  name: string | null;
  role: string | null;
  title: string | null;
  reportsToAgentId: string | null;
  adapterType: string | null;
  model: string | null;
  /** null when the request names no budget; 0 means no monthly limit is set. */
  budgetMonthlyCents: number | null;
  capabilities: string | null;
  skills: string[];
  /** The agent this request acts on: approval activates it and rejection terminates it. Null when approval creates one. */
  agentId: string | null;
};

export function approvalHireFacts(payload?: Record<string, unknown> | null): ApprovalHireFacts {
  const adapterConfig =
    payload?.adapterConfig && typeof payload.adapterConfig === "object" && !Array.isArray(payload.adapterConfig)
      ? (payload.adapterConfig as Record<string, unknown>)
      : null;
  return {
    name: firstNonEmptyString(payload?.name),
    role: firstNonEmptyString(payload?.role),
    title: firstNonEmptyString(payload?.title),
    reportsToAgentId: firstNonEmptyString(payload?.reportsTo),
    adapterType: firstNonEmptyString(payload?.adapterType),
    model: firstNonEmptyString(adapterConfig?.model),
    budgetMonthlyCents:
      typeof payload?.budgetMonthlyCents === "number" && Number.isFinite(payload.budgetMonthlyCents)
        ? payload.budgetMonthlyCents
        : null,
    capabilities: approvalReadableText(firstNonEmptyString(payload?.capabilities)),
    skills: uniqueStrings(payload?.desiredSkills),
    agentId: firstNonEmptyString(payload?.agentId),
  };
}

/**
 * Agent-written text as readable plain text. Line breaks, numbering, bullets
 * and indentation are structure, so they stay; only the markup around the
 * words goes. Identifiers keep their underscores and tildes, and a leading
 * ">" or "+" stays where it is (it may be a comparison or a sign): the board
 * must read what the agent wrote. Every pattern is bounded, so a hostile
 * payload cannot stall the page.
 */
export function approvalReadableText(value: string | null | undefined): string | null {
  if (!value) return null;
  const plain = value
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/!\[([^\]\n]{0,300})\]\([^)\n]{0,2000}\)/g, "$1")
    // A link keeps its target: where it points can be what the board is approving.
    .replace(/\[([^\]\n]{1,300})\]\(([^)\n]{0,2000})\)/g, (_match, text: string, url: string) =>
      url && url !== text ? `${text} (${url})` : text,
    )
    .split("\n")
    .map((line) => line.trimEnd())
    // A line that is only a rule (---, ***, ___) carries no words.
    .filter((line) => !/^ {0,3}([-*_])(?: {0,2}\1){2,}$/.test(line))
    .map((line) =>
      line
        .replace(/^ {0,3}#{1,6} +/, "")
        .replace(/^( {0,12})[-*] +/, "$1• ")
        .replace(/\*\*(?=\S)([^\n*]{0,200}?\S)\*\*/g, "$1")
        .replace(/`([^`\n]{1,200})`/g, "$1"),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain || null;
}

export type ApprovalStrategyPlan =
  | { kind: "text"; text: string }
  /** The request carries a plan, but not as text the summary can show. */
  | { kind: "unreadable" }
  | { kind: "missing" };

const STRATEGY_PLAN_FIELDS = ["plan", "description", "strategy", "text"] as const;

/** The plan a strategy approval asks the board to accept. */
export function approvalStrategyPlan(payload?: Record<string, unknown> | null): ApprovalStrategyPlan {
  const text = approvalReadableText(
    firstNonEmptyString(...STRATEGY_PLAN_FIELDS.map((field) => payload?.[field])),
  );
  if (text) return { kind: "text", text };
  const plan = payload?.plan;
  if (Array.isArray(plan) && plan.length > 0 && plan.every((step) => typeof step === "string")) {
    const joined = approvalReadableText(plan.join("\n"));
    if (joined) return { kind: "text", text: joined };
  }
  return plan !== null && plan !== undefined && typeof plan !== "string" ? { kind: "unreadable" } : { kind: "missing" };
}

/** The decision brief of a strategy approval, without the plan fields the summary shows as the plan. */
export function approvalStrategyBrief(payload?: Record<string, unknown> | null) {
  const rest: Record<string, unknown> = { ...(payload ?? {}) };
  for (const field of STRATEGY_PLAN_FIELDS) delete rest[field];
  return approvalDecisionBrief(rest);
}

/** The first lines of a long text, cut at a line or word boundary. */
export function approvalTextPreview(
  text: string,
  maxLines = 6,
  maxLength = 480,
): { preview: string; truncated: boolean } {
  const lines = text.split("\n");
  let preview = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (preview.length > maxLength) {
    const clipped = preview.slice(0, maxLength + 1);
    const boundary = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("\n"));
    let end = boundary > maxLength / 2 ? boundary : maxLength;
    // Never cut between the two halves of one character (an emoji, for example).
    const last = preview.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    preview = preview.slice(0, end);
    truncated = true;
  }
  return { preview: truncated ? `${preview.trimEnd()}…` : preview, truncated };
}

/**
 * One line for a title or a subject: the readable text with its line breaks
 * folded into spaces, cut at a word boundary. Built on
 * {@link approvalReadableText}, so it drops markup and nothing else.
 */
export function approvalExcerpt(value: string | null, maxLength = 240): string | null {
  const plain = approvalReadableText(value)?.replace(/\s+/g, " ");
  if (!plain) return null;
  if (plain.length <= maxLength) return plain;

  const clipped = plain.slice(0, maxLength + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  let end = wordBoundary > maxLength / 2 ? wordBoundary : maxLength;
  // Never cut between the two halves of one character (an emoji, for example).
  const last = plain.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${plain.slice(0, end).trimEnd()}…`;
}

export function approvalSubject(payload?: Record<string, unknown> | null, type?: string): string | null {
  // A hire is about a named agent; its `title` is the job title, not the subject.
  if (type === "hire_agent") return firstNonEmptyString(payload?.name, payload?.title);
  return firstNonEmptyString(
    payload?.title,
    payload?.name,
    payload?.summary,
    payload?.recommendedAction,
  );
}

export function isEmailReplyPayload(payload?: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  const hasBody = typeof payload.body === "string" && payload.body.trim().length > 0;
  const hasEnvelope =
    typeof payload.subject === "string" ||
    typeof payload.recipient === "string" ||
    typeof payload.channel === "string";
  return hasBody && hasEnvelope;
}

export type ApprovalEmailDraft = {
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string;
};

/** The outgoing draft of an email-reply approval. Never a source for the original request. */
export function approvalEmailDraft(payload?: Record<string, unknown> | null): ApprovalEmailDraft | null {
  if (!payload || !isEmailReplyPayload(payload)) return null;
  return {
    from: firstNonEmptyString(payload.channel),
    to: firstNonEmptyString(payload.recipient),
    subject: firstNonEmptyString(payload.subject),
    body: String(payload.body),
  };
}

/** A compact surface shows an outgoing draft whole up to this many characters. */
export const APPROVAL_DRAFT_PREVIEW_LENGTH = 1500;

/**
 * What a compact surface shows of an outgoing draft before it is expanded: the
 * first characters, cut at a line or word boundary. Null when the whole body is
 * shown, so a caller can tell a cut draft from a whole one. Trailing blank
 * space hides no words and does not count towards the limit.
 */
export function approvalDraftPreview(body: string): string | null {
  if (body.trimEnd().length <= APPROVAL_DRAFT_PREVIEW_LENGTH) return null;
  // The cut depends only on the first characters; a very long body is not scanned whole.
  return approvalTextPreview(
    body.slice(0, APPROVAL_DRAFT_PREVIEW_LENGTH + 1),
    Number.MAX_SAFE_INTEGER,
    APPROVAL_DRAFT_PREVIEW_LENGTH,
  ).preview;
}

/** Build a contextual label for an approval, e.g. "Hire Agent: Designer" */
export function approvalLabel(type: string, payload?: Record<string, unknown> | null): string {
  const base = typeLabel[type] ?? type;
  const subject = approvalSubject(payload, type);
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
  // The same field order the summary reads. A plan that is not text is shown as the request's data.
  const plan = firstNonEmptyString(...STRATEGY_PLAN_FIELDS.map((field) => payload[field]));
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      <PayloadField label="Title" value={payload.title} />
      {plan ? (
        <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground whitespace-pre-wrap wrap-anywhere font-mono text-xs">
          {plan}
        </div>
      ) : (
        <pre className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap wrap-anywhere">
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

/**
 * Decision-list items (pros, cons & risks) render inside a custom bullet row,
 * so a leading list marker ("- ", "* ", "• ", "1. ", "1) ") would show a
 * second marker beside the first. Strip exactly one leading marker.
 */
export function stripLeadingListMarker(value: string): string {
  return value.replace(/^(?:[-*•]|\d{1,3}[.)])[^\S\n]+/, "");
}

function BoardApprovalPayloadContent({ payload }: { payload: Record<string, unknown> }) {
  const brief = approvalDecisionBrief(payload);
  const title = firstNonEmptyString(payload.title);
  const summary = firstNonEmptyString(payload.summary);
  const reasoning = brief.reasoning === summary ? null : brief.reasoning;
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
          <MarkdownBody className="leading-6 text-foreground/90">{summary}</MarkdownBody>
        </div>
      )}
      {brief.recommendation && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{brief.recommendation}</MarkdownBody>
        </div>
      )}
      <OriginalRequestBlock payload={payload} />
      {reasoning && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Why</p>
          <MarkdownBody className="leading-6 text-foreground/90">{reasoning}</MarkdownBody>
        </div>
      )}
      {(brief.pros.length > 0 || brief.cons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DecisionList label="Pros" items={brief.pros} />
          <DecisionList label="Risks" items={brief.cons} />
        </div>
      )}
      {brief.nextAction && (
        <div className="rounded-lg border border-border/60 bg-background/60 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">On approval</p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{brief.nextAction}</MarkdownBody>
        </div>
      )}
      {proposedComment && (
        <div className="space-y-1.5">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Proposed comment
          </p>
          <pre className="rounded-lg border border-border/60 bg-muted/50 px-3.5 py-3 font-mono text-xs leading-5 text-muted-foreground whitespace-pre-wrap wrap-anywhere">
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

function DecisionList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">{label}</p>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {items.map((item, index) => {
          const text = stripLeadingListMarker(item);
          if (!text) return null;
          return (
            <li key={`${index}-${text}`} className="flex items-start gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <MarkdownBody className="leading-6">{text}</MarkdownBody>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function EmailReplyPayload({ payload }: { payload: Record<string, unknown> }) {
  const brief = approvalDecisionBrief(payload);
  const channel = firstNonEmptyString(payload.channel);
  const recipient = firstNonEmptyString(payload.recipient);
  const subject = firstNonEmptyString(payload.subject);
  const orderRef = firstNonEmptyString(payload.threadOrOrderRef);
  const gate = firstNonEmptyString(payload.gate);
  const body = firstNonEmptyString(payload.body) ?? "";
  const intent = firstNonEmptyString(payload.intent);
  const reasoning = brief.reasoning === intent ? null : brief.reasoning;

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
      </div>

      {intent && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Intent</p>
          <p className="leading-6 text-foreground/90">{intent}</p>
        </div>
      )}
      {brief.recommendation && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-amber-700 dark:text-amber-300">
            Recommended action
          </p>
          <p className="mt-1 leading-6 text-foreground">{brief.recommendation}</p>
        </div>
      )}
      <OriginalRequestBlock payload={payload} />
      {reasoning && (
        <div className="space-y-1">
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">Why</p>
          <p className="leading-6 text-foreground/90">{reasoning}</p>
        </div>
      )}
      {(brief.pros.length > 0 || brief.cons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <DecisionList label="Pros" items={brief.pros} />
          <DecisionList label="Risks" items={brief.cons} />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
          Proposed reply
        </p>
        <pre className="whitespace-pre-wrap wrap-anywhere rounded-md bg-muted/40 p-3 text-sm leading-6 text-foreground">
          {body}
        </pre>
      </div>
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
