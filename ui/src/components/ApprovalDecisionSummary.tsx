import { useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { cn, formatCents } from "@/lib/utils";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import {
  approvalDecisionBrief,
  approvalDraftPreview,
  approvalEmailDraft,
  type ApprovalEmailDraft,
  approvalHireFacts,
  approvalOriginalRequest,
  approvalReadableText,
  approvalStrategyBrief,
  approvalStrategyPlan,
  approvalTextPreview,
  OriginalRequestBlock,
  stripLeadingListMarker,
} from "./ApprovalPayload";

/**
 * Resolves an agent id to a display name. Returns null when the agent list is
 * loaded and holds no such agent, and undefined while the list is not known.
 */
export type ApprovalAgentNameResolver = (agentId: string) => string | null | undefined;

const labelClass =
  "text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground";
const moreClass =
  "mt-1 inline-flex min-h-6 items-center text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground";
const emptyClass = "mt-1 text-sm leading-5 text-muted-foreground";
const LIST_PREVIEW_COUNT = 2;
const SKILL_PREVIEW_COUNT = 6;
// What a compact surface shows of each field before "Show more".
const RECOMMENDATION_PREVIEW = { maxLines: 3, maxLength: 180 };
const WHY_PREVIEW = { maxLines: 3, maxLength: 220 };
const NEXT_ACTION_PREVIEW = { maxLines: 3, maxLength: 220 };
const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/**
 * One pro or risk as readable plain text. The item sits beside a bullet, so a
 * leading list marker of its own is dropped. An item that is itself a list
 * (a later line carries a marker at the same level) keeps every marker:
 * dropping only the first would leave a list that starts at "2.".
 */
function decisionPointText(item: string): string | null {
  const text = approvalReadableText(item);
  if (!text) return null;
  const isList = text
    .split("\n")
    .slice(1)
    .some((line) => stripLeadingListMarker(line) !== line);
  return isList ? text : stripLeadingListMarker(text).trim() || null;
}

/** Pros or risks. `full` lists every item; otherwise the first two, with the rest one click away. */
function DecisionPoints({ label, items, full }: { label: string; items: string[]; full: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const points = items.flatMap((item) => {
    const text = decisionPointText(item);
    return text ? [text] : [];
  });
  const hidden = full ? 0 : points.length - LIST_PREVIEW_COUNT;
  const visible = full || expanded ? points : points.slice(0, LIST_PREVIEW_COUNT);

  return (
    <div className="min-w-0">
      <p className={labelClass}>{label}</p>
      {points.length === 0 ? (
        <p className={emptyClass}>Not supplied.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm leading-5 text-foreground">
          {visible.map((point, index) => (
            <li key={`${index}-${point}`} className="flex items-start gap-2">
              <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0 whitespace-pre-wrap break-words">{point}</span>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <button
          type="button"
          className={moreClass}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show fewer" : `+${hidden} more`}
        </button>
      )}
    </div>
  );
}

/**
 * Lets the parent that also renders the decision buttons own whether a long
 * draft is shown whole: Approve must not send a draft that is still cut.
 */
export type ApprovalDraftControl = {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Receives the draft block, so the parent can move focus to it. */
  ref?: Ref<HTMLDivElement>;
};

/** The outgoing draft a summary of this approval shows, if it shows one. */
function summaryEmailDraft(type: string, payload?: Record<string, unknown> | null) {
  return type === "request_board_approval" ? approvalEmailDraft(payload) : null;
}

/** Shown beside the decision buttons when Approve opened a cut draft instead of sending. */
export const APPROVAL_DRAFT_UNREAD_MESSAGE = "Read the full reply, then approve.";

/**
 * Keeps an outgoing email from being approved unread. A compact summary cuts a
 * long draft; while it is cut, the first Approve opens it and moves focus to
 * it instead of sending. Pass `draftControl` to the summary and `approveGuard`
 * to the decision buttons rendered beside it.
 */
export function useApprovalDraftGate(type: string, payload?: Record<string, unknown> | null) {
  const [expanded, setExpanded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const revealRequested = useRef(false);
  const draft = summaryEmailDraft(type, payload);
  const isCut = draft !== null && approvalDraftPreview(draft.body) !== null;

  // Runs once the whole draft is on the page, so the scroll sees its real height.
  useEffect(() => {
    if (!revealRequested.current) return;
    revealRequested.current = false;
    const block = ref.current;
    if (!block) return;
    block.focus({ preventScroll: true });
    block.scrollIntoView?.({ block: "nearest" });
  });

  /** The message to show when Approve is held back, or null when it may send. */
  const approveGuard = (): string | null => {
    if (!isCut || expanded) return null;
    revealRequested.current = true;
    setExpanded(true);
    return APPROVAL_DRAFT_UNREAD_MESSAGE;
  };

  const draftControl: ApprovalDraftControl = { expanded, onExpandedChange: setExpanded, ref };
  return { draftControl, approveGuard };
}

function ApprovalEmailDraftBlock({
  draft,
  full,
  control,
}: {
  draft: ApprovalEmailDraft;
  /** Show the whole draft, with nothing to expand. */
  full: boolean;
  /** Without it the block keeps its own expanded state. */
  control?: ApprovalDraftControl;
}) {
  const [ownExpanded, setOwnExpanded] = useState(false);
  const labelId = useId();
  const expanded = control ? control.expanded : ownExpanded;
  const setExpanded = control ? control.onExpandedChange : setOwnExpanded;
  // A long draft is cut on compact surfaces only, and always behind a button that states its size.
  const preview = full ? null : approvalDraftPreview(draft.body);
  const canExpand = preview !== null;
  const envelope = [
    ["From", draft.from],
    ["To", draft.to],
    ["Subject", draft.subject],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <div
      ref={control?.ref}
      className="min-w-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-approval-draft
      role="group"
      aria-labelledby={labelId}
      // Focusable so a held-back Approve can put the reader on the draft it opened.
      tabIndex={canExpand ? -1 : undefined}
    >
      <p id={labelId} className={labelClass}>
        Draft reply
      </p>
      <div className="mt-2 overflow-hidden rounded-lg border border-border/60">
        {envelope.length > 0 && (
          <dl className="space-y-1 border-b border-border/60 bg-muted/30 px-3.5 py-2.5 text-sm">
            {envelope.map(([label, value]) => (
              <div key={label} className="flex gap-2">
                <dt className={cn(labelClass, "w-16 shrink-0 pt-0.5")}>{label}</dt>
                <dd className="min-w-0 break-words text-foreground/90">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="px-3.5 py-3">
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground" data-approval-draft-body>
            {canExpand && !expanded ? preview : draft.body}
          </div>
        </div>
      </div>
      {canExpand && (
        <button
          type="button"
          className={moreClass}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "Show less" : `Show full reply (${draft.body.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

/**
 * Agent-written text with its line breaks, shown by its first lines until
 * expanded. Text that is already readable plain text goes in; `full` shows all
 * of it with nothing to expand.
 */
function ReadableText({
  text,
  maxLines,
  maxLength,
  full = false,
  moreLabel = "Show more",
}: {
  text: string;
  maxLines: number;
  maxLength: number;
  full?: boolean;
  moreLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { preview, truncated } = useMemo(() => {
    // A control that reveals a single extra line takes the room of that line: show the line.
    const cut = approvalTextPreview(text, maxLines, maxLength);
    return cut.truncated && approvalTextPreview(text, maxLines + 1, maxLength).truncated
      ? cut
      : { preview: text, truncated: false };
  }, [text, maxLines, maxLength]);
  const collapsible = truncated && !full;

  return (
    <>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
        {collapsible && !expanded ? preview : text}
      </p>
      {collapsible && (
        <button
          type="button"
          className={moreClass}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : moreLabel}
        </button>
      )}
    </>
  );
}

/**
 * One labelled field of the decision brief (recommendation, why, if approved),
 * as readable plain text. `emptyText` is shown where the request must state the
 * field and does not; without it an empty field is left out.
 */
function DecisionField({
  label,
  value,
  maxLines,
  maxLength,
  full,
  emptyText,
}: {
  label: string;
  value: string | null;
  maxLines: number;
  maxLength: number;
  full: boolean;
  emptyText?: string;
}) {
  const text = useMemo(() => approvalReadableText(value), [value]);
  if (!text && !emptyText) return null;

  return (
    <div className="min-w-0">
      <p className={labelClass}>{label}</p>
      {text ? (
        <ReadableText text={text} maxLines={maxLines} maxLength={maxLength} full={full} />
      ) : (
        <p className={emptyClass}>{emptyText}</p>
      )}
    </div>
  );
}

function isActionableStatus(status: string | undefined) {
  return status === undefined || status === "pending" || status === "revision_requested";
}

/**
 * What a hire approval puts in front of the board: who the agent is, where it
 * sits, what it runs on, what it may spend, and what each decision does.
 */
function HireAgentSummary({
  payload,
  status,
  resolveAgentName,
  full,
  className,
}: {
  payload?: Record<string, unknown> | null;
  status?: string;
  resolveAgentName?: ApprovalAgentNameResolver;
  full: boolean;
  className?: string;
}) {
  const [showAllSkills, setShowAllSkills] = useState(false);
  const hire = approvalHireFacts(payload);
  const managerName = hire.reportsToAgentId ? resolveAgentName?.(hire.reportsToAgentId) : undefined;
  // A manager the loaded agent list does not hold is said so; a raw id is never shown.
  const manager = hire.reportsToAgentId
    ? managerName === undefined
      ? null
      : (managerName ?? "An agent that is not in this company's list")
    : null;
  const runsOn = hire.adapterType
    ? [getAdapterLabel(hire.adapterType), hire.model].filter(Boolean).join(" \u00b7 ")
    : null;
  const hasBudget = hire.budgetMonthlyCents !== null && hire.budgetMonthlyCents > 0;
  const budget = hasBudget
    ? formatCents(hire.budgetMonthlyCents!)
    : hire.budgetMonthlyCents === null
      ? "Not stated in the request"
      : "No monthly limit";
  const role = hire.role ? (Object.hasOwn(roleLabels, hire.role) ? roleLabels[hire.role] : hire.role) : null;
  const facts = [
    ["Role", role],
    ["Job title", hire.title && hire.title !== hire.name ? hire.title : null],
    ["Reports to", manager],
    ["Runs on", runsOn],
    ["Monthly budget", budget],
  ].filter((fact): fact is [string, string] => Boolean(fact[1]));
  const hiddenSkills = full ? 0 : hire.skills.length - SKILL_PREVIEW_COUNT;
  const skills = full || showAllSkills ? hire.skills : hire.skills.slice(0, SKILL_PREVIEW_COUNT);
  const agentName = hire.name ?? "The agent";
  // The server acts on whatever agent the request names. If that is not the agent
  // being hired, the board must see it before it decides.
  const linkedAgentName = hire.agentId ? resolveAgentName?.(hire.agentId) : undefined;
  const linkedToOtherAgent = Boolean(linkedAgentName && hire.name && linkedAgentName !== hire.name);

  return (
    <div className={cn("space-y-3", className)} data-approval-hire>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className={labelClass}>{label}</dt>
            <dd className="mt-1 break-words text-sm leading-5 text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="min-w-0">
        <p className={labelClass}>What it will do</p>
        {hire.capabilities ? (
          <ReadableText text={hire.capabilities} maxLines={4} maxLength={220} full={full} />
        ) : (
          <p className={emptyClass}>The request does not describe the agent's work.</p>
        )}
      </div>
      {hire.skills.length > 0 && (
        <div className="min-w-0">
          <p className={labelClass}>{hire.agentId ? "Skills" : "Requested skills (not applied on approval)"}</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {skills.map((skill) => (
              <li
                key={skill}
                className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-micro) text-foreground/80"
              >
                {skill}
              </li>
            ))}
          </ul>
          {hiddenSkills > 0 && (
            <button
              type="button"
              className={moreClass}
              aria-expanded={showAllSkills}
              onClick={() => setShowAllSkills((current) => !current)}
            >
              {showAllSkills ? "Show fewer" : `+${hiddenSkills} more`}
            </button>
          )}
        </div>
      )}
      {isActionableStatus(status) &&
        (linkedToOtherAgent ? (
          <p className="text-sm leading-5 text-foreground" role="note">
            This request is linked to the existing agent {linkedAgentName}, not to a new agent named {hire.name}.
            Approving activates {linkedAgentName}; rejecting terminates it.
          </p>
        ) : (
          <div className={cn("grid gap-3", hire.agentId && "sm:grid-cols-2")}>
            <div className="min-w-0">
              <p className={labelClass}>If approved</p>
              <p className="mt-1 text-sm leading-5 text-foreground">
                {agentName} is {hire.agentId ? "activated" : "created"}.
                {hasBudget ? ` Its monthly budget is set to ${formatCents(hire.budgetMonthlyCents!)}.` : ""}
              </p>
            </div>
            {hire.agentId && (
              <div className="min-w-0">
                <p className={labelClass}>If rejected</p>
                <p className="mt-1 text-sm leading-5 text-foreground">The pending agent is terminated.</p>
              </div>
            )}
          </div>
        ))}
    </div>
  );
}

/**
 * The plan itself, with its line breaks and numbering, instead of a one-line
 * excerpt. A strategy may also carry the decision fields a Board approval has;
 * what it carries is shown under the plan.
 */
function StrategySummary({
  payload,
  full,
  className,
}: {
  payload?: Record<string, unknown> | null;
  full: boolean;
  className?: string;
}) {
  const plan = useMemo(() => approvalStrategyPlan(payload), [payload]);
  const brief = approvalStrategyBrief(payload);
  // With no plan field, the request's own rationale is the closest thing to one.
  const planText = plan.kind === "text" ? plan.text : approvalReadableText(brief.reasoning);
  const why = plan.kind === "text" ? brief.reasoning : null;

  return (
    <div className={cn("space-y-3", className)}>
      <DecisionField label="Recommendation" value={brief.recommendation} {...RECOMMENDATION_PREVIEW} full={full} />
      <div className="min-w-0" data-approval-plan>
        <p className={labelClass}>Plan</p>
        {planText ? (
          <ReadableText text={planText} maxLines={6} maxLength={480} full={full} moreLabel="Show full plan" />
        ) : (
          <p className={emptyClass}>
            {plan.kind === "unreadable"
              ? "The plan is not plain text. Open the full request to read it."
              : "The request contains no plan text."}
          </p>
        )}
      </div>
      <DecisionField label="Why" value={why} {...WHY_PREVIEW} full={full} />
      {(brief.pros.length > 0 || brief.cons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {brief.pros.length > 0 && <DecisionPoints label="Pros" items={brief.pros} full={full} />}
          {brief.cons.length > 0 && <DecisionPoints label="Risks" items={brief.cons} full={full} />}
        </div>
      )}
      <DecisionField label="If approved" value={brief.nextAction} {...NEXT_ACTION_PREVIEW} full={full} />
    </div>
  );
}

export function ApprovalDecisionSummary({
  type,
  payload,
  className,
  resolveAgentName,
  full = false,
  status,
  draftControl,
}: {
  type: string;
  payload?: Record<string, unknown> | null;
  className?: string;
  /** The approval status. What a decision will do is stated only while a decision is still open. */
  status?: string;
  /** Lets a hire request name the manager the agent reports to. */
  resolveAgentName?: ApprovalAgentNameResolver;
  /** Show long text in full: for pages with room for it, such as the approval detail page. */
  full?: boolean;
  /** Hands the draft's expanded state to the parent (see {@link useApprovalDraftGate}); without it the summary keeps its own. */
  draftControl?: ApprovalDraftControl;
}) {
  if (type === "hire_agent") {
    return (
      <HireAgentSummary
        payload={payload}
        status={status}
        resolveAgentName={resolveAgentName}
        full={full}
        className={className}
      />
    );
  }
  if (type === "approve_ceo_strategy") {
    return <StrategySummary payload={payload} full={full} className={className} />;
  }

  const brief = approvalDecisionBrief(payload);
  const isBoardApproval = type === "request_board_approval";
  const draft = summaryEmailDraft(type, payload);
  const hasBrief =
    isBoardApproval ||
    Boolean(
      brief.recommendation || brief.reasoning || brief.pros.length > 0 || brief.cons.length > 0 || brief.nextAction,
    );
  if (!hasBrief) {
    // A page that shows the summary in full says so when there is nothing to show.
    return full ? (
      <p className={cn("text-sm leading-5 text-muted-foreground", className)}>
        This request carries no recommendation, rationale, pros or risks.
      </p>
    ) : null;
  }

  // Requests filed before decision fields were required carry no source, pros or risks.
  // One line says so (the header line already notes the missing source); empty
  // fields would only bury the recommendation.
  const isBareLegacyRequest =
    isBoardApproval &&
    !approvalOriginalRequest(payload) &&
    brief.pros.length === 0 &&
    brief.cons.length === 0;
  const showPoints = !isBareLegacyRequest && (isBoardApproval || brief.pros.length > 0 || brief.cons.length > 0);
  // In full, a Board approval states the fields its request leaves empty instead of dropping them.
  const emptyText = full && isBoardApproval ? "Not supplied." : undefined;

  return (
    <div className={cn("space-y-3", className)}>
      <DecisionField
        label="Recommendation"
        value={brief.recommendation}
        {...RECOMMENDATION_PREVIEW}
        full={full}
        emptyText={emptyText}
      />
      {/* Compact: an announced preview, and a missing source is noted once in the header line. In full: all of it. */}
      {isBoardApproval && <OriginalRequestBlock payload={payload} compact={!full} />}
      <DecisionField label="Why" value={brief.reasoning} {...WHY_PREVIEW} full={full} emptyText={emptyText} />
      {showPoints && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(brief.pros.length > 0 || isBoardApproval) && (
            <DecisionPoints label="Pros" items={brief.pros} full={full} />
          )}
          {(brief.cons.length > 0 || isBoardApproval) && (
            <DecisionPoints label="Risks" items={brief.cons} full={full} />
          )}
        </div>
      )}
      {isBareLegacyRequest && (
        <p className="text-sm leading-5 text-muted-foreground">
          Older request: no pros or risks were recorded.
        </p>
      )}
      {draft && <ApprovalEmailDraftBlock draft={draft} full={full} control={draftControl} />}
      <DecisionField label="If approved" value={brief.nextAction} {...NEXT_ACTION_PREVIEW} full={full} />
    </div>
  );
}
