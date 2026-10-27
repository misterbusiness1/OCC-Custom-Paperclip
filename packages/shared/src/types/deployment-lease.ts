/** Public operator status. Owner capabilities and capability hashes are never included. */
export interface DeploymentLeaseStatus {
  protocolVersion: 1;
  generation: number;
  bootId: string;
  ownerBootId: string | null;
  owned: boolean;
  expired: boolean;
  startedAt: string | null;
  expiresAt: string | null;
  draining: boolean;
  drainStartedAt: string | null;
}

/** Returned only by successful acquisition, never GET or mutation audit events. */
export interface AcquiredDeploymentLease extends DeploymentLeaseStatus {
  ownerToken: string;
}
