export interface Chronology {
  readonly chronology: string;
  readonly riskLevel: number;
  /**
   * A display string, NOT an instant. The server sends back whatever precision the reporter gave
   * ("March 2024", "2024-03-11"), so parsing it into a Date would invent precision that is not
   * there.
   */
  readonly incidentDate?: string;
}
