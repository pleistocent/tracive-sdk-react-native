import type { CreditSource } from './enums';

export interface Billing {
  readonly creditSource: CreditSource;
  readonly unitsCharged: number;
  readonly partnerBalanceRemaining?: number;
}
