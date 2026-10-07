import { Fragment, useState, type ReactNode } from "react";
import { UserPlus, Lightbulb, ShieldAlert, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";
import { MarkdownBody } from "./MarkdownBody";
import { formatCents } from "../lib/utils";
import { approvalReadableText } from "../lib/approval-readable-text";

export { approvalReadableText };

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

/** Resolves an agent id to a display name; null or undefined when it is not known. */
type OriginalRequestSenderResolver = (agentId: string) => string | null | undefined;

/** The shape of an agent id. A user id is free text and, in practice, never this shape. */
const SENDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A local user id as the server writes them (`local-board`, `local-implicit-board`): one bare token, no address, no words. */
const LOCAL_USER_ID_PATTERN = /^local-[a-z0-9_-]+$/i;

/**
 * Who sent the original request, as a name the board can read. An id is
 * resolved to a name or left out, never printed.
 *
 * For a Paperclip comment the server stores the author's id: an agent id (a
 * UUID) or a board user's id (any other text). An agent is named from the
 * company's agents. A sender that is not a UUID is a board user and is shown as
 * "Board", the name the discussion list gives every non-agent author. A UUID
 * the agent list does not hold is left out: it may be an agent that has since
 * been removed, and calling its comment the Board's own instruction on the page
 * where the board decides whether to act on it would be wrong.
 *
 * A sender the requesting agent supplied for an external source is kept as
 * written (`local-pickup@shop.example` is an address, not an id) unless it is
 * a UUID or a bare local user id.
 */
export function approvalOriginalRequestSender(
  source: ApprovalOriginalRequest["source"],
  resolveAgentName?: OriginalRequestSenderResolver,
): string | null {
  const sender = source.sender?.trim();
  if (!sender) return null;
  const isAgentIdShaped = SENDER_ID_PATTERN.test(sender);
  const isComment = source.kind === "paperclip_comment";
  const isId = isComment || isAgentIdShaped || LOCAL_USER_ID_PATTERN.test(sender);
  if (!isId) return sender;
  const name = resolveAgentName?.(sender)?.trim();
  if (name) return name;
  if (sender === "local-board") return "Board";
  return isComment && !isAgentIdShaped ? "Board" : null;
}

/** The time a request was sent, to the minute. Null when the value is not a date. */
function originalRequestSentAt(sentAt: string | undefined): string | null {
  if (!sentAt) return null;
  const date = new Date(sentAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function OriginalRequestBlock({
  payload,
  compact = false,
  resolveAgentName,
}: {
  payload?: Record<string, unknown> | null;
  compact?: boolean;
  /** Names the agent that wrote a Paperclip comment. Without it, or for an unknown agent id, no sender is shown; a board user is shown as Board. */
  resolveAgentName?: OriginalRequestSenderResolver;
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
  const sentAt = originalRequestSentAt(original.source.sentAt);
  // What the board needs to know about the text below, not how it is stored.
  const sourceNote =
    original.source.kind === "external" && original.source.snapshotOrigin === "requester"
      ? "Quoted by the requesting agent, not verified"
      : original.source.kind === "paperclip_comment" && original.source.snapshotOrigin === "server"
        ? "Saved from the original comment"
        : null;
  const provenance: Array<{ key: string; node: ReactNode }> = [
    { key: "channel", node: original.source.kind === "external" ? original.source.channel : null },
    { key: "sender", node: approvalOriginalRequestSender(original.source, resolveAgentName) },
    { key: "sentAt", node: sentAt ? <time dateTime={original.source.sentAt}>{sentAt}</time> : null },
    // The comment link below replaces the raw comment reference.
    { key: "reference", node: commentHref ? null : original.source.reference },
    { key: "note", node: sourceNote },
    {
      key: "comment",
      node: commentHref ? (
        <Link to={commentHref} className="underline underline-offset-2 hover:text-foreground">
          View comment
        </Link>
      ) : null,
    },
  ].filter((part) => Boolean(part.node));

  return (
    <div>
      <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
        Original request
      </p>
      {provenance.length > 0 && (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {provenance.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 ? " · " : ""}
              {part.node}
            </Fragment>
          ))}
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

/** How far a cut moves back to stay out of a character cluster; a longer cluster is cut as any long run is. */
const CLUSTER_REACH = 64;

/** Undefined until first asked for; null where the browser has no `Intl.Segmenter`. */
let graphemeSegmenter: Intl.Segmenter | null | undefined;

/**
 * The cut position at or before `end` that does not fall inside one character
 * as the reader sees it: a letter with its accent or tone mark, a flag, an
 * emoji joined from several, a keycap. A cut inside one changes the last thing
 * read before the ellipsis (a Thai syllable without its tone mark is another
 * syllable). Where the browser cannot tell, and for a cluster longer than
 * {@link CLUSTER_REACH}, only the two halves of a surrogate pair are kept
 * together.
 */
function clusterSafeEnd(text: string, end: number): number {
  if (end <= 0 || end >= text.length) return end;
  if (graphemeSegmenter === undefined) {
    try {
      graphemeSegmenter =
        typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
          ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
          : null;
    } catch {
      graphemeSegmenter = null;
    }
  }
  if (graphemeSegmenter) {
    // Read from the start of the text: whether two flag letters pair up depends on how many precede them.
    const cluster = graphemeSegmenter.segment(text.slice(0, end + CLUSTER_REACH)).containing(end);
    if (cluster && cluster.index > 0 && end - cluster.index <= CLUSTER_REACH) return cluster.index;
  }
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? end - 1 : end;
}

/** The first lines of a long text, cut at a line or word boundary, with nothing added to mark the cut. */
function cutTextPreview(text: string, maxLines: number, maxLength: number): { preview: string; truncated: boolean } {
  const lines = text.split("\n");
  let preview = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;
  if (preview.length > maxLength) {
    const clipped = preview.slice(0, maxLength + 1);
    const boundary = Math.max(clipped.lastIndexOf(" "), clipped.lastIndexOf("\n"));
    // Never cut inside one character (an emoji, or a letter and its accent, for example).
    const end = clusterSafeEnd(preview, boundary > maxLength / 2 ? boundary : maxLength);
    preview = preview.slice(0, end);
    truncated = true;
  }
  return { preview: truncated ? preview.trimEnd() : preview, truncated };
}

/** The first lines of a long text, cut at a line or word boundary; a cut preview ends in an ellipsis. */
export function approvalTextPreview(
  text: string,
  maxLines = 6,
  maxLength = 480,
): { preview: string; truncated: boolean } {
  const { preview, truncated } = cutTextPreview(text, maxLines, maxLength);
  return { preview: truncated ? `${preview}…` : preview, truncated };
}

/** Characters of raw text an excerpt converts beyond four times its length: one label, one target, and their brackets. */
const EXCERPT_RAW_MARGIN = 2400;
/** How far back from that limit the cut looks for a space or a line break. */
const EXCERPT_RAW_BOUNDARY_REACH = 200;

/**
 * One line for a title or a subject: the readable text with its line breaks
 * folded into spaces, cut at a word boundary. Built on
 * {@link approvalReadableText}, so it drops markup and nothing else.
 */
export function approvalExcerpt(value: string | null, maxLength = 240): string | null {
  // A one-line excerpt reads only the start of the text, so only the start is converted. The
  // margin lets markup shrink the text fourfold and leaves room for one link of the longest
  // kind; a text of any length then costs the same.
  const rawLimit = Number.isFinite(maxLength) ? maxLength * 4 + EXCERPT_RAW_MARGIN : Number.POSITIVE_INFINITY;
  let raw = value;
  let rawWasCut = false;
  if (raw && raw.length > rawLimit) {
    let end = rawLimit;
    // Cut between words where one is near, so that no half of a token or of a rule line is left.
    const boundary = Math.max(raw.lastIndexOf(" ", end), raw.lastIndexOf("\n", end));
    if (boundary > end - EXCERPT_RAW_BOUNDARY_REACH) end = boundary;
    raw = raw.slice(0, clusterSafeEnd(raw, end));
    rawWasCut = true;
  }
  const plain = approvalReadableText(raw)?.replace(/\s+/g, " ");
  if (!plain) return null;
  // Text that was cut before conversion is never presented as the whole text.
  if (plain.length <= maxLength) return rawWasCut ? `${plain.trimEnd()}…` : plain;

  const clipped = plain.slice(0, maxLength + 1);
  const wordBoundary = clipped.lastIndexOf(" ");
  // Never cut inside one character (an emoji, or a letter and its accent, for example).
  const end = clusterSafeEnd(plain, wordBoundary > maxLength / 2 ? wordBoundary : maxLength);
  return `${plain.slice(0, end).trimEnd()}…`;
}

/**
 * What a request asks for, as one line for a collapsed queue row: the
 * recommendation of a Board approval, what a hire will do, or the first line
 * of a strategy's plan. Null when the request carries none of it. The line is
 * the readable text itself; the row cuts it to its width with CSS.
 */
export function approvalAskLine(
  type: string,
  payload?: Record<string, unknown> | null,
): { label: string; text: string } | null {
  if (type === "hire_agent") {
    const text = approvalExcerpt(firstNonEmptyString(payload?.capabilities));
    return text ? { label: "What it will do", text } : null;
  }
  if (type === "approve_ceo_strategy") {
    const plan = approvalStrategyPlan(payload);
    // With no plan field the summary shows the rationale as the plan; the row follows it.
    const planText =
      plan.kind === "text" ? plan.text : approvalReadableText(approvalStrategyBrief(payload).reasoning);
    const firstLine = planText?.split("\n").find((line) => line.trim()) ?? null;
    const text = approvalExcerpt(firstLine);
    return text ? { label: "Plan", text } : null;
  }
  const text = approvalExcerpt(approvalDecisionBrief(payload).recommendation);
  return text ? { label: "Recommendation", text } : null;
}

/** How much of a request's subject a card or queue row shows as its title. */
export const APPROVAL_TITLE_LENGTH = 120;

/** Longest summary that is checked against the recommendation, rationale and title for being a repeat. */
const SUMMARY_COMPARE_LIMIT = 20_000;

function comparableText(value: string | null | undefined): string | null {
  return approvalReadableText(value)?.replace(/\s+/g, " ").trim().toLocaleLowerCase() ?? null;
}

/**
 * The request's `summary`, when the surface does not already show the same
 * text: as the recommendation, as the rationale (which falls back to the
 * summary when the request gives no other), or as the title. Agents are told to
 * send a summary and may put the cost in it, so it must not go unshown. A
 * summary that is the title is still returned when the title is too long to be
 * shown whole.
 */
export function approvalSummaryText(payload?: Record<string, unknown> | null, type?: string): string | null {
  const summary = firstNonEmptyString(payload?.summary);
  if (!summary) return null;
  const brief = approvalDecisionBrief(payload);
  // A summary this long is not converted and compared with the other fields: it is shown, unless
  // it is the very text shown as the recommendation or the rationale (which falls back to the
  // summary), and would be on the page twice. That check takes the two texts whole, as they are.
  // Comparing a prefix instead would treat a summary that only starts like the recommendation as
  // already shown.
  if (summary.length > SUMMARY_COMPARE_LIMIT) {
    return summary === brief.recommendation || summary === brief.reasoning ? null : summary;
  }
  const comparable = comparableText(summary);
  if (!comparable) return null;
  if (comparable === comparableText(brief.recommendation) || comparable === comparableText(brief.reasoning)) {
    return null;
  }
  const isShownAsTitle =
    comparable === comparableText(approvalSubject(payload, type)) && comparable.length <= APPROVAL_TITLE_LENGTH;
  return isShownAsTitle ? null : summary;
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
  /** The payload's `channel`: a free-text description of how the reply goes out, not an address. */
  via: string | null;
  /** The sender, only when the payload names one in `from`. */
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string;
};

/** The outgoing draft of an email-reply approval. Never a source for the original request. */
export function approvalEmailDraft(payload?: Record<string, unknown> | null): ApprovalEmailDraft | null {
  if (!payload || !isEmailReplyPayload(payload)) return null;
  return {
    via: firstNonEmptyString(payload.channel),
    from: firstNonEmptyString(payload.from),
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
 *
 * The preview holds the draft's own characters and nothing else. An ellipsis
 * here would sit inside the email body, where it could be read as part of the
 * email; the caller states that the reply continues, outside the body.
 */
export function approvalDraftPreview(body: string): string | null {
  if (body.trimEnd().length <= APPROVAL_DRAFT_PREVIEW_LENGTH) return null;
  // The cut depends only on the first characters; a very long body is not scanned whole. The
  // characters past the limit are there so that the cut can see the character it would split.
  return cutTextPreview(
    body.slice(0, APPROVAL_DRAFT_PREVIEW_LENGTH + CLUSTER_REACH),
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
  resolveAgentName,
}: {
  payload: Record<string, unknown>;
  hideTitle?: boolean;
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  const nextPayload = hideTitle ? { ...payload, title: undefined } : payload;
  return (
    <BoardApprovalPayloadContent payload={nextPayload} resolveAgentName={resolveAgentName} />
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

function BoardApprovalPayloadContent({
  payload,
  resolveAgentName,
}: {
  payload: Record<string, unknown>;
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
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
            Recommendation
          </p>
          <MarkdownBody className="mt-1 leading-6 text-foreground">{brief.recommendation}</MarkdownBody>
        </div>
      )}
      <OriginalRequestBlock payload={payload} resolveAgentName={resolveAgentName} />
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
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">If approved</p>
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

export function EmailReplyPayload({
  payload,
  resolveAgentName,
}: {
  payload: Record<string, unknown>;
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  const brief = approvalDecisionBrief(payload);
  // `channel` describes how the reply goes out ("email from info@"); only `from` names a sender.
  const channel = firstNonEmptyString(payload.channel);
  const sender = firstNonEmptyString(payload.from);
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
          {channel && <EmailHeaderRow label="Via" value={channel} />}
          {sender && <EmailHeaderRow label="From" value={sender} />}
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
            Recommendation
          </p>
          <p className="mt-1 leading-6 text-foreground">{brief.recommendation}</p>
        </div>
      )}
      <OriginalRequestBlock payload={payload} resolveAgentName={resolveAgentName} />
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
          Draft reply
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
  resolveAgentName,
}: {
  type: string;
  payload: Record<string, unknown>;
  hidePrimaryTitle?: boolean;
  /** Names the agent that wrote the original request's comment. */
  resolveAgentName?: OriginalRequestSenderResolver;
}) {
  if (type === "hire_agent") return <HireAgentPayload payload={payload} />;
  if (type === "budget_override_required") return <BudgetOverridePayload payload={payload} />;
  if (type === "request_board_approval") {
    if (isEmailReplyPayload(payload)) return <EmailReplyPayload payload={payload} resolveAgentName={resolveAgentName} />;
    return (
      <BoardApprovalPayload payload={payload} hideTitle={hidePrimaryTitle} resolveAgentName={resolveAgentName} />
    );
  }
  return <CeoStrategyPayload payload={payload} />;
}
