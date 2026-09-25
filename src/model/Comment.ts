export interface Comment {
  /**
   * The month it was posted, as `"YYYY-MM"`. A display string, not an instant — same reason as
   * {@link Chronology.incidentDate}.
   */
  readonly date: string;
  readonly text: string;
  readonly fromCredibleReport: boolean;
}
