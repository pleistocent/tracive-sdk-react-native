import { describe, expect, it } from '@jest/globals';

import {
  checkResponseBody,
  FakeClock,
  FakeTransport,
  jsonResponse,
} from '../../__tests__/support/fakes';
import { InMemoryCheckCache } from '../../cache/CheckCache';
import { isTraciveError, type TraciveError } from '../../model/TraciveError';
import { TraciveMode } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../../oauth/TokenStore';
import { TraciveQuery } from '../../query/TraciveQuery';
import { RetryPolicy } from '../RetryPolicy';
import { TraciveClient } from '../TraciveClient';

const QRIS_HIT = checkResponseBody({
  riskTier: 'CAUTION',
  qris: { merchantName: 'TOKO CONTOH', city: 'JAKARTA', criteria: 'UMI', acquirer: 'ID.DANA.WWW' },
  rightOfReply: { text: 'Kami pemilik usaha ini.', language: 'id' },
});

function build(transport: FakeTransport): TraciveClient {
  const clock = new FakeClock();
  return new TraciveClient({
    mode: TraciveMode.oauth({
      clientId: 'partner-app',
      redirectUri: 'https://your.app/oauth/callback',
      partnerUserId: 'partner-user-1',
    }),
    transport,
    clock,
    cache: new InMemoryCheckCache({ clock }),
    tokenStore: new InMemoryTokenStore({
      accessToken: 'live-token',
      tokenType: 'Bearer',
      scopes: ['scammer.check'],
    }),
    retryPolicy: RetryPolicy.disabled,
  });
}

describe('a QRIS check', () => {
  it('sends the folded NMID as the query, and replays the owner reply from the cache', async () => {
    const transport = new FakeTransport().enqueue(jsonResponse(200, QRIS_HIT));
    const client = build(transport);
    const query = TraciveQuery.qrisNmid(' id1020 0000 00033 ');

    const first = await client.checkScammer(query);
    expect(JSON.parse(transport.requests[0]?.body ?? '{}').query).toBe('QRIS_ID1020000000033');
    expect(first.rightOfReply?.text).toBe('Kami pemilik usaha ini.');

    const replay = await client.checkScammer(query);
    expect(replay.origin).toBe('CACHE');
    expect(replay.qris?.merchantName).toBe('TOKO CONTOH');
    expect(replay.rightOfReply).toEqual({ text: 'Kami pemilik usaha ini.', language: 'id' });
    expect(transport.requests).toHaveLength(1);
  });

  it('does not answer a PAN from the NMID entry, because they are separate cache entries', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, QRIS_HIT));
    const client = build(transport);

    await client.checkScammer(TraciveQuery.qrisNmid('ID1020000000033'));
    await client.checkScammer(TraciveQuery.qrisPan('936009143100000003'));
    expect(transport.requests).toHaveLength(2);
    expect(JSON.parse(transport.requests[1]?.body ?? '{}').query).toBe('QRIS_936009143100000003');
  });

  it('surfaces unsupportedInputType for an organisation not cleared for QRIS', async () => {
    const transport = new FakeTransport().enqueue(
      jsonResponse(400, {
        error: { code: 'unsupported_input_type', message: 'Unsupported query type.' },
      }),
    );
    let thrown: unknown;
    try {
      await build(transport).checkScammer(TraciveQuery.qrisNmid('ID1020000000033'));
    } catch (error) {
      thrown = error;
    }
    expect(isTraciveError(thrown)).toBe(true);
    expect((thrown as TraciveError).kind).toBe('unsupportedInputType');
  });
});
