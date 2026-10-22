import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Approval } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function ApprovalRevocation({ approval, onResolved }: { approval: Approval; onResolved: () => void }) {
  const [reason, setReason] = useState("");
  const revoke = useMutation({
    mutationFn: () => approvalsApi.revoke(approval.id, {
      decisionNote: reason.trim(), expectedUpdatedAt: new Date(approval.updatedAt).toISOString(),
    }),
    onSuccess: onResolved,
    onError: onResolved,
  });
  if (approval.status !== "approved" || approval.type !== "request_board_approval") return null;
  return (
    <details className="rounded-lg border border-border px-4 py-3">
      <summary className="cursor-pointer text-sm font-medium">Withdraw this approval</summary>
      <p className="mt-2 text-sm text-muted-foreground">
        Cancels pending execution for this request. If execution has started, reconcile its outcome first. This cannot undo a completed action.
      </p>
      <label className="mt-3 block text-sm">
        Reason for revocation
        <Textarea className="mt-1" value={reason} onChange={event => setReason(event.target.value)} disabled={revoke.isPending} />
      </label>
      <Button className="mt-2" variant="destructive" disabled={!reason.trim() || revoke.isPending} onClick={() => revoke.mutate()}>
        {revoke.isPending ? "Revoking…" : "Revoke approval"}
      </Button>
      {revoke.error && <p role="alert" className="mt-2 text-sm text-destructive">
        {revoke.error instanceof Error ? revoke.error.message : "Revocation failed. Reload and review the current request."}
      </p>}
    </details>
  );
}
