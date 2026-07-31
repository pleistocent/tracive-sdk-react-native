export interface ProfileInfo {
  /** A pairwise pseudonymous identifier: stable for this client, useless to any other. */
  readonly sub: string;
  readonly name?: string;
  readonly country?: string;
  readonly tier?: string;
  readonly memberSince?: Date;
}
