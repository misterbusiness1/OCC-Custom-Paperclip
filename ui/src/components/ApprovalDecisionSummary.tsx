import { cn } from "@/lib/utils";
import { approvalDecisionBrief, approvalExcerpt, OriginalRequestBlock } from "./ApprovalPayload";

export function ApprovalDecisionSummary({
  type,
  payload,
  className,
}: {
  type: string;
  payload?: Record<string, unknown> | null;
  className?: string;
}) {
  const brief = approvalDecisionBrief(payload);
  const recommendation = approvalExcerpt(brief.recommendation, 180);
  const reasoning = approvalExcerpt(brief.reasoning, 220);
  const benefit = approvalExcerpt(brief.pros[0] ?? null, 160);
  const tradeoff = approvalExcerpt(brief.cons[0] ?? null, 160);
  const showMissingDecisionFields = type === "request_board_approval";
  const hasBrief = showMissingDecisionFields || Boolean(recommendation || reasoning || benefit || tradeoff);
  if (!hasBrief) return null;

  return (
    <div className={cn("space-y-3", className)}>
      {recommendation && (
        <div>
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Recommendation
          </p>
          <p className="mt-1 text-sm leading-5 text-foreground">{recommendation}</p>
        </div>
      )}
      {showMissingDecisionFields && <OriginalRequestBlock payload={payload} compact />}
      {reasoning && (
        <div>
          <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
            Why
          </p>
          <p className="mt-1 text-sm leading-5 text-foreground">{reasoning}</p>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {(benefit || showMissingDecisionFields) && (
          <div>
            <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
              Benefit
            </p>
            <p className={cn("mt-1 text-sm leading-5", benefit ? "text-foreground" : "text-muted-foreground")}>
              {benefit ?? "Not supplied."}
            </p>
          </div>
        )}
        {(tradeoff || showMissingDecisionFields) && (
          <div>
            <p className="text-(length:--text-micro) font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
              Tradeoff
            </p>
            <p className={cn("mt-1 text-sm leading-5", tradeoff ? "text-foreground" : "text-muted-foreground")}>
              {tradeoff ?? "Not supplied."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
