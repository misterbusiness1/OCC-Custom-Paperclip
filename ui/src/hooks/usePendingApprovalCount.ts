import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";
import { approvalListQuery } from "../lib/approval-queue";

/**
 * How many approvals of a company wait on the board: the same requests the
 * Approvals page lists under "To decide". It reads the company's approvals list
 * under the key the Approvals page, the inbox and the inbox badge use, so the
 * list is fetched once and a live approval event refreshes every reader.
 */
export function usePendingApprovalCount(companyId: string | null | undefined): number {
  const { data } = useQuery({
    ...approvalListQuery(companyId!),
    enabled: !!companyId,
    select: (approvals) => approvals.filter((approval) => approval.status === "pending").length,
  });
  return data ?? 0;
}
