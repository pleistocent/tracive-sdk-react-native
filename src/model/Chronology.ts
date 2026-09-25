export interface Chronology {
  readonly chronology: string;
  readonly riskLevel: number;
  /**
   * The month it happened, as `"YYYY-MM"` (e.g. `"2026-06"`). A display string, NOT an instant: the
   * server never sends a day, so parsing it into a Date would invent precision that is not there.
   */
  readonly incidentDate?: string;
}
