export interface CreditsInfo {
  readonly subscriptionCredits: number;
  /** Owned by billing and changes without an SDK release, so it is a plain string. */
  readonly tier: string;
  readonly nextResetAt?: Date;
}
