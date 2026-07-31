export interface Comment {
  /** A display string, not an instant — same reason as {@link Chronology.incidentDate}. */
  readonly date: string;
  readonly text: string;
  readonly fromCredibleReport: boolean;
}
