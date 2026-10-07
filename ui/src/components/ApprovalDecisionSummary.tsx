import { useMemo, useState } from "react";
import { AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { cn, formatCents } from "@/lib/utils";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import {
  approvalDecisionBrief,
  approvalEmailDraft,
  approvalExcerpt,
  approvalHireFacts,
  approvalOriginalRequest,
  approvalPlainText,
  approvalStrategyBrief,
  approvalStrategyPlan,
  approvalTextPreview,
  OriginalRequestBlock,
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
const LIST_PREVIEW_COUNT = 2;
const DRAFT_PREVIEW_LENGTH = 320;
const SKILL_PREVIEW_COUNT = 6;
const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

/** Shows the clipped excerpt first; the full text stays one click away on the card. */
function ExpandableText({ value, limit }: { value: string; limit: number }) {
  const [expanded, setExpanded] = useState(false);
  const excerpt = approvalExcerpt(value, limit);
  const full = approvalPlainText(value);
  if (!excerpt || !full) return null;
  const canExpand = full.replace(/\s+/g, " ").length > limit;

  return (
    <>
      <p className="mt-1 whitespace-pre-line break-words text-sm leading-5 text-foreground">
        {expanded ? full : excerpt}
      </p>
      {canExpand && (
        <button
          type="button"
          className={moreClass}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function DecisionPoints({ label, items }: { label: string; items: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const points = items.flatMap((item) => {
    const text = approvalPlainText(item);
    return text ? [text] : [];
  });
  const hidden = points.length - LIST_PREVIEW_COUNT;
  const visible = expanded ? points : points.slice(0, LIST_PREVIEW_COUNT);

  return (
    <div className="min-w-0">
      <p className={labelClass}>{label}</p>
      {points.length === 0 ? (
        <p className="mt-1 text-sm leading-5 text-muted-foreground">Not supplied.</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm leading-5 text-foreground">
          {visible.map((point, index) => (
            <li key={`${index}-${point}`} className="flex items-start gap-2">
              <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
              <span className="min-w-0 break-words">{point}</span>
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

export function ApprovalEmailDraftBlock({ payload }: { payload?: Record<string, unknown> | null }) {
  const [expanded, setExpanded] = useState(false);
  const draft = approvalEmailDraft(payload);
  if (!draft) return null;
  const canExpand = draft.body.length > DRAFT_PREVIEW_LENGTH;
  const envelope = [
    ["From", draft.from],
    ["To", draft.to],
    ["Subject", draft.subject],
  ].filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <div className="min-w-0" data-approval-draft>
      <p className={labelClass}>Draft reply</p>
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
        {/* The clamp sits inside the padding so a cut-off line cannot show through it. */}
        <div className="px-3.5 py-3">
          <div
            className={cn(
              "whitespace-pre-wrap break-words text-sm leading-6 text-foreground",
              canExpand && !expanded && "line-clamp-5",
            )}
          >
            {draft.body}
          </div>
        </div>
      </div>
      {canExpand && (
        <button
          type="button"
          className={moreClass}
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show less" : "Show full reply"}
        </button>
      )}
    </div>
  );
}

/** Agent-written text with its line breaks, shown by its first lines until expanded. */
function ReadableText({
  text,
  maxLines,
  maxLength,
  full = false,
  moreLabel,
}: {
  text: string;
  maxLines: number;
  maxLength: number;
  full?: boolean;
  moreLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { preview, truncated } = useMemo(
    () => approvalTextPreview(text, maxLines, maxLength),
    [text, maxLines, maxLength],
  );
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
  const hiddenSkills = hire.skills.length - SKILL_PREVIEW_COUNT;
  const skills = showAllSkills ? hire.skills : hire.skills.slice(0, SKILL_PREVIEW_COUNT);
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
          <ReadableText text={hire.capabilities} maxLines={4} maxLength={220} full={full} moreLabel="Show more" />
        ) : (
          <p className="mt-1 text-sm leading-5 text-muted-foreground">The request does not describe the agent's work.</p>
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
  const planText = plan.kind === "text" ? plan.text : approvalPlainText(brief.reasoning);
  const why = plan.kind === "text" ? brief.reasoning : null;

  return (
    <div className={cn("space-y-3", className)}>
      {brief.recommendation && (
        <div className="min-w-0">
          <p className={labelClass}>Recommendation</p>
          <ExpandableText value={brief.recommendation} limit={180} />
        </div>
      )}
      <div className="min-w-0" data-approval-plan>
        <p className={labelClass}>Plan</p>
        {planText ? (
          <ReadableText text={planText} maxLines={6} maxLength={480} full={full} moreLabel="Show full plan" />
        ) : (
          <p className="mt-1 text-sm leading-5 text-muted-foreground">
            {plan.kind === "unreadable"
              ? "The plan is not plain text. Open the full request to read it."
              : "The request contains no plan text."}
          </p>
        )}
      </div>
      {why && (
        <div className="min-w-0">
          <p className={labelClass}>Why</p>
          <ExpandableText value={why} limit={220} />
        </div>
      )}
      {(brief.pros.length > 0 || brief.cons.length > 0) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {brief.pros.length > 0 && <DecisionPoints label="Pros" items={brief.pros} />}
          {brief.cons.length > 0 && <DecisionPoints label="Risks" items={brief.cons} />}
        </div>
      )}
      {brief.nextAction && (
        <div className="min-w-0">
          <p className={labelClass}>If approved</p>
          <ExpandableText value={brief.nextAction} limit={220} />
        </div>
      )}
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
  const hasDraft = isBoardApproval && approvalEmailDraft(payload) !== null;
  const hasBrief =
    isBoardApproval ||
    Boolean(brief.recommendation || brief.reasoning || brief.pros.length > 0 || brief.cons.length > 0);
  if (!hasBrief) return null;

  // Requests filed before decision fields were required carry no source, pros or risks.
  // One line says so (the header line already notes the missing source); empty
  // fields would only bury the recommendation.
  const isBareLegacyRequest =
    isBoardApproval &&
    !approvalOriginalRequest(payload) &&
    brief.pros.length === 0 &&
    brief.cons.length === 0;
  const showPoints = !isBareLegacyRequest && (isBoardApproval || brief.pros.length > 0 || brief.cons.length > 0);

  return (
    <div className={cn("space-y-3", className)}>
      {brief.recommendation && (
        <div className="min-w-0">
          <p className={labelClass}>Recommendation</p>
          <ExpandableText value={brief.recommendation} limit={180} />
        </div>
      )}
      {isBoardApproval && <OriginalRequestBlock payload={payload} compact />}
      {brief.reasoning && (
        <div className="min-w-0">
          <p className={labelClass}>Why</p>
          <ExpandableText value={brief.reasoning} limit={220} />
        </div>
      )}
      {showPoints && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(brief.pros.length > 0 || isBoardApproval) && <DecisionPoints label="Pros" items={brief.pros} />}
          {(brief.cons.length > 0 || isBoardApproval) && <DecisionPoints label="Risks" items={brief.cons} />}
        </div>
      )}
      {isBareLegacyRequest && (
        <p className="text-sm leading-5 text-muted-foreground">
          Older request: no pros or risks were recorded.
        </p>
      )}
      {hasDraft && <ApprovalEmailDraftBlock payload={payload} />}
      {brief.nextAction && (
        <div className="min-w-0">
          <p className={labelClass}>If approved</p>
          <ExpandableText value={brief.nextAction} limit={220} />
        </div>
      )}
    </div>
  );
}
