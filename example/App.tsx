/**
 * A runnable example for `@pleistocent/tracive-sdk-react-native`.
 *
 * WHAT IT DEMONSTRATES, and why each part is here:
 *
 *   * `TraciveClient` built in OAuth mode with NO API KEY, because the surface has no parameter
 *     for one.
 *   * `normalizePhoneNumber` and `TraciveQuery`: the key sent to the server is shown next to the
 *     raw input, so the grammar is visible rather than described.
 *   * The persistent cache, on real `expo-sqlite` + `expo-secure-store`. The fake backend's call
 *     counter is on screen, so a cache hit is visibly NOT a call.
 *   * The `disclaimer`, rendered on every result. The contract says surface it in any UI built on
 *     an SDK result, so this UI surfaces it.
 *   * The two shared fixtures, executed on Hermes. See `src/conformance.ts` — that panel is the
 *     one check in the whole design that can fail for the reason the fixtures exist.
 *
 * THREE FLAVORS (src/flavor.ts). `demo`, the default, answers every call in-process from
 * `DemoBackend`, injected as the client's `transport`, so the app runs on a first clone with no
 * credentials and nothing to reach, and behaves identically every time it runs in CI. `sandbox`
 * and `production` are the real integration: `fetch` against that environment, and the OAuth round
 * trip through the Tracive app. `openSession` below is the whole difference between them.
 *
 * Everything you must supply is marked `TODO(partner)`: `grep -rn "TODO(partner)" example`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  isTraciveError,
  isTraciveQueryError,
  normalizePhoneNumber,
  TraciveClient,
  TraciveEnvironment,
  TraciveMode,
  TraciveOAuth,
  TraciveQuery,
  TraciveScopes,
  type AuthResult,
  type CheckResult,
  type OAuthConfiguration,
  type RiskTier,
} from '@pleistocent/tracive-sdk-react-native';
import {
  expoRandom,
  expoSecurePendingAuthorizationStore,
  expoSecureTokenStore,
  openExpoCheckCache,
} from '@pleistocent/tracive-sdk-react-native/expo';

import { DemoBackend } from './src/demoBackend';
import { runConformance, type ConformanceReport } from './src/conformance';
import { currentFlavor, type Flavor } from './src/flavor';

const FLAVOR: Flavor = currentFlavor();

// TODO(partner): your own values — the client id and redirect per environment are in
// src/flavor.ts. A redirect must be an https App Link / Universal Link on a host you own: a custom
// scheme is claimed first-come on both platforms, so any other app could receive the authorization
// code. The Expo config plugin in app.json writes the manifest, Info.plist and entitlements entries
// for an https redirect; `npm run doctor` checks the result.
const OAUTH_CONFIG: OAuthConfiguration = {
  clientId: FLAVOR.clientId,
  redirectUri: FLAVOR.redirectUri,
  partnerUserId: 'partner-user-1',
  scopes: [TraciveScopes.scammerCheck],
};

const COUNTRIES = ['IDN', 'USA', 'ITA'] as const;
type Country = (typeof COUNTRIES)[number];

interface Session {
  readonly client: TraciveClient;
  /** Only the demo has one; the live flavors talk to the real API. */
  readonly backend?: DemoBackend;
}

const TIER_COLOR: Record<RiskTier, string> = {
  HIGH: '#B42318',
  ELEVATED: '#B54708',
  CAUTION: '#854A0E',
  NONE: '#067647',
};

async function openSession(flavor: Flavor): Promise<Session> {
  // Real `expo-sqlite` rows, encrypted with a key held in the real keychain / Android Keystore.
  // Never throws: a cache that cannot open degrades to a cold cache with `lastStoreError` set.
  const cache = await openExpoCheckCache({ random: expoRandom });
  const tokenStore = expoSecureTokenStore();

  const environment = flavor.environment;
  if (environment !== undefined) {
    // The real integration. The environment goes to the OAuth flow as well as the client: the flow
    // owns the authorize URL and the token endpoint, and on its own it would default to production.
    const oauth = new TraciveOAuth({
      mode: OAUTH_CONFIG,
      environment,
      tokenStore,
      pendingStore: expoSecurePendingAuthorizationStore(),
      random: expoRandom,
    });
    const client = new TraciveClient({
      mode: TraciveMode.oauth(OAUTH_CONFIG),
      environment,
      cache,
      oauth,
      random: expoRandom,
    });
    return { client };
  }

  const backend = new DemoBackend();

  const oauth = new TraciveOAuth({
    mode: OAUTH_CONFIG,
    transport: backend,
    tokenStore,
    // Without this the PKCE verifier dies with the process, and an authorization interrupted by
    // Android reclaiming the app can never be completed.
    pendingStore: expoSecurePendingAuthorizationStore(),
    random: expoRandom,
  });

  // Demo only. A real app calls `client.authorize()` and the grant arrives back through the
  // redirect, which is what the live flavors do. Consent happens in the Tracive app on the same
  // device, which the demo cannot assume is installed, so a grant is planted directly in the same
  // secure store the real flow writes to — which is what lets everything downstream be the real
  // code path.
  await tokenStore.write({
    accessToken: 'demo-access-token-0',
    refreshToken: 'demo-refresh-token-0',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: [TraciveScopes.scammerCheck],
  });

  const client = new TraciveClient({
    mode: TraciveMode.oauth(OAUTH_CONFIG),
    cache,
    oauth,
    // The one line that keeps the demo offline; the live flavors pass `environment` instead and
    // the SDK uses `fetch` against its base URL. Injecting a transport stays a supported seam, and
    // it is how you would test your own screens.
    transport: backend,
    random: expoRandom,
  });

  return { client, backend };
}

export default function App() {
  const [session, setSession] = useState<Session | undefined>();
  const [startupError, setStartupError] = useState<string | undefined>();
  const [country, setCountry] = useState<Country>('IDN');
  const [input, setInput] = useState('0857-1860-9079');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [calls, setCalls] = useState(0);
  const [rows, setRows] = useState(0);
  const [authorized, setAuthorized] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const conformance = useRef<ConformanceReport | undefined>(undefined);
  if (conformance.current === undefined) conformance.current = runConformance();
  const report = conformance.current;

  useEffect(() => {
    let live = true;
    openSession(FLAVOR).then(
      (opened) => {
        if (live) setSession(opened);
      },
      (cause: unknown) => {
        if (live) setStartupError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, []);

  /**
   * The fold, recomputed on every keystroke. Both steps throw rather than returning a query the
   * server can never match, and nothing is sent until the button is pressed — the point being that
   * a malformed identifier costs nothing, while a lookup that misses is still billed.
   */
  const folded = useMemo(() => {
    try {
      const e164 = normalizePhoneNumber(country, input);
      return { e164, key: TraciveQuery.phone(e164).searchQueryIndex, reason: undefined };
    } catch (cause) {
      return {
        e164: undefined,
        key: undefined,
        reason: isTraciveQueryError(cause) ? cause.reason : 'unknown',
      };
    }
  }, [country, input]);

  // The live flavors' OAuth wiring. Started once per session: the listener also picks up the link
  // that cold-started the app, which is how a flow survives the OS killing this process while the
  // user was in the Tracive app.
  useEffect(() => {
    if (session === undefined || FLAVOR.environment === undefined) return undefined;
    const { client } = session;
    const stopResults = client.onAuthResult((result) => {
      setAuthorized(result.type === 'authorized');
      setNotice(describeAuthResult(result));
    });
    const stopLinks = client.startLinkListener();
    void client.isAuthorized().then(setAuthorized);
    return () => {
      stopLinks();
      stopResults();
    };
  }, [session]);

  const authorize = useCallback(async () => {
    if (session === undefined) return;
    setNotice(undefined);
    const start = await session.client.authorize();
    // null: the consent screen is open, and the outcome arrives at onAuthResult above.
    setNotice(
      start === null
        ? 'Consent screen opened. Finish it in the Tracive app.'
        : describeAuthResult(start),
    );
  }, [session]);

  const signOut = useCallback(async () => {
    if (session === undefined) return;
    await session.client.signOut();
    setAuthorized(false);
    setResult(undefined);
    setNotice('Signed out. The grant and the cached verdicts are gone.');
    setRows(await session.client.cache.count());
  }, [session]);

  const refreshCounters = useCallback(async (active: Session) => {
    setCalls(active.backend?.callCount ?? 0);
    setRows(await active.client.cache.count());
  }, []);

  const check = useCallback(async () => {
    if (session === undefined || folded.e164 === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const query = TraciveQuery.phone(folded.e164);
      setResult(await session.client.checkScammer(query));
    } catch (cause) {
      setResult(undefined);
      setError(
        isTraciveError(cause)
          ? `${cause.kind}: ${cause.message}`
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      await refreshCounters(session);
      setBusy(false);
    }
  }, [folded.e164, refreshCounters, session]);

  const clearCache = useCallback(async () => {
    if (session === undefined) return;
    await session.client.clearCache();
    setResult(undefined);
    await refreshCounters(session);
  }, [refreshCounters, session]);

  const expireGrant = useCallback(() => {
    if (session?.backend === undefined) return;
    session.backend.expireNextAccessToken = true;
    setError(undefined);
  }, [session]);

  if (startupError !== undefined) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <Text style={styles.failure}>The SDK could not start: {startupError}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Tracive RN</Text>
        {FLAVOR.environment === undefined ? (
          <Text style={styles.subtitle}>
            SDK sample, demo flavor. Every response comes from an in-process fake injected as the
            client's transport, so this runs with no credentials and no network. The sandbox and
            production flavors talk to the real API.
          </Text>
        ) : (
          <>
            <Text style={styles.environment}>
              {FLAVOR.name} · {TraciveEnvironment.baseUrl(FLAVOR.environment)}
            </Text>
            <Text style={styles.subtitle}>
              SDK sample. Every check is a real call to this environment.
            </Text>
            <View style={styles.row}>
              <Pressable
                onPress={authorize}
                disabled={session === undefined || authorized}
                style={[styles.button, (session === undefined || authorized) && styles.buttonOff]}
              >
                <Text style={styles.buttonText}>{authorized ? 'Authorized' : 'Authorize'}</Text>
              </Pressable>
              <Pressable
                onPress={signOut}
                disabled={session === undefined || !authorized}
                style={styles.buttonAlt}
              >
                <Text style={styles.buttonAltText}>Sign out</Text>
              </Pressable>
            </View>
          </>
        )}
        {notice !== undefined ? <Text style={styles.hint}>{notice}</Text> : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>1 · An identifier, as a person would write it</Text>
          <View style={styles.row}>
            {COUNTRIES.map((code) => (
              <Pressable
                key={code}
                onPress={() => setCountry(code)}
                style={[styles.chip, country === code && styles.chipOn]}
              >
                <Text style={[styles.chipText, country === code && styles.chipTextOn]}>{code}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            value={input}
            onChangeText={setInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="phone-pad"
            style={styles.input}
            placeholder="0857-1860-9079"
          />
          <Label text="E.164" />
          <Text style={folded.e164 === undefined ? styles.failure : styles.mono}>
            {folded.e164 ?? `rejected locally · ${folded.reason} · nothing sent, nothing billed`}
          </Text>
          <Label text="Folded lookup key" />
          <Text style={folded.key === undefined ? styles.failure : styles.mono}>
            {folded.key ?? '—'}
          </Text>
        </View>

        <View style={styles.row}>
          <Pressable
            onPress={check}
            disabled={busy || session === undefined || folded.e164 === undefined}
            style={[
              styles.button,
              (busy || session === undefined || folded.e164 === undefined) && styles.buttonOff,
            ]}
          >
            <Text style={styles.buttonText}>{busy ? 'Checking…' : 'Check'}</Text>
          </Pressable>
          <Pressable onPress={clearCache} disabled={session === undefined} style={styles.buttonAlt}>
            <Text style={styles.buttonAltText}>Clear cache</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Press Check twice with the same number: the second answer is served from the cache
          {session?.backend !== undefined ? ', and the call counter below does not move.' : '.'}
        </Text>

        {busy ? <ActivityIndicator style={styles.spinner} /> : null}
        {error !== undefined ? <Text style={styles.failure}>{error}</Text> : null}
        {result !== undefined ? <Verdict result={result} /> : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>3 · Provenance</Text>
          {session?.backend !== undefined ? (
            <Fact
              label="Calls that reached the backend"
              value={String(calls)}
              note="A cache hit is not a call."
            />
          ) : null}
          <Fact label="Rows in the encrypted SQLite cache" value={String(rows)} />
          {session?.backend !== undefined ? (
            <>
              <Fact
                label="Last Idempotency-Key"
                value={session.backend.lastIdempotencyKey ?? '—'}
                note="Sent on every check, whether or not you supply one."
              />
              <Fact
                label="Access tokens issued"
                value={String(session.backend.tokenSerial)}
                note="Rises when a 401 forces one refresh and a replay."
              />
              <Pressable onPress={expireGrant} style={styles.buttonAlt}>
                <Text style={styles.buttonAltText}>Expire the grant, then check</Text>
              </Pressable>
            </>
          ) : null}
        </View>

        <Conformance report={report} />
      </ScrollView>
    </View>
  );
}

function describeAuthResult(result: AuthResult): string {
  switch (result.type) {
    case 'authorized':
      return `Authorized. Scopes granted: ${result.grantedScopes.join(', ')}`;
    // Only reachable for a confidential client; this example is public.
    // TODO(partner): a confidential client forwards the code and verifier over TLS to its own
    // backend, which completes the exchange.
    case 'codeReceived':
      return 'Authorization code received. Forward it to your backend.';
    case 'denied':
      return 'You declined the request.';
    case 'appNotInstalled':
      return 'Install the Tracive app first — the install page has been opened.';
    case 'failed':
      return `${result.error.kind}: ${result.error.message}`;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Split rather than `new Date(month)`: a Date would need a day, and a local-zone parse can shift
// the month.
function formatMonth(month: string): string {
  const [year, index] = month.split('-');
  return `${MONTHS[Number(index) - 1] ?? index} ${year}`;
}

function Verdict({ result }: { result: CheckResult }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>2 · The verdict</Text>
      <View style={styles.row}>
        <View style={[styles.pill, { backgroundColor: TIER_COLOR[result.riskTier] }]}>
          <Text style={styles.pillText}>{result.riskTier}</Text>
        </View>
        <View style={[styles.pill, result.origin === 'CACHE' ? styles.pillCache : styles.pillWire]}>
          <Text style={styles.pillText}>
            {result.origin === 'CACHE' ? 'CACHE · free' : 'SERVER · 1 credit'}
          </Text>
        </View>
      </View>
      <Fact label="Found" value={result.found ? 'yes' : 'no'} />
      <Fact
        label="Reports"
        value={`${result.reportTotal} total · ${result.credibleReports} credible · ${result.ambiguousReports} ambiguous`}
      />
      {result.firstReportOn !== undefined && result.lastReportOn !== undefined ? (
        <Fact
          label="Reported"
          value={`${formatMonth(result.firstReportOn)} – ${formatMonth(result.lastReportOn)}`}
          note="Month and year only; the server never sends a day."
        />
      ) : null}
      {result.tags.length > 0 ? <Fact label="Tags" value={result.tags.join(', ')} /> : null}
      <Fact label="Check id" value={result.checkId ?? 'none — a cache hit performed no check'} />
      <Fact
        label="Data fetched at"
        value={result.fetchedAt.toISOString()}
        note="The age of the data, not of the answer."
      />
      {result.disclaimer !== undefined ? (
        <View style={styles.disclaimer}>
          <Text style={styles.disclaimerLabel}>Disclaimer</Text>
          <Text style={styles.disclaimerText}>{result.disclaimer}</Text>
        </View>
      ) : null}
    </View>
  );
}

function Conformance({ report }: { report: ConformanceReport }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>4 · Engine conformance, on this device</Text>
      <Text style={styles.hint}>
        The shared grammar fixture (v{report.grammarFixtureVersion}) and the phone-normalization
        vectors (v{report.phoneFixtureVersion}), folded on Hermes rather than on Node. Jest cannot
        answer this: it runs with full ICU.
      </Text>
      <View style={[styles.pill, report.ok ? styles.pillPass : styles.pillFail]}>
        <Text style={styles.pillText}>
          {report.ok ? 'PASS' : 'FAIL'} · {report.passed}/{report.total}
        </Text>
      </View>
      {report.groups.map((group) => (
        <View key={group.name}>
          <Fact
            label={group.name}
            value={`${group.passed}/${group.total}${group.skipped > 0 ? ` · ${group.skipped} not reachable from the public surface` : ''}`}
          />
          {group.failures.map((failure) => (
            <Text key={failure} style={styles.failure}>
              {failure}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

function Label({ text }: { text: string }) {
  return <Text style={styles.label}>{text}</Text>;
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <View style={styles.fact}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.factValue}>{value}</Text>
      {note !== undefined ? <Text style={styles.hint}>{note}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F6F8' },
  centered: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { padding: 16, paddingTop: 64, paddingBottom: 48, gap: 12 },
  title: { fontSize: 28, fontWeight: '700', color: '#101828' },
  subtitle: { fontSize: 13, color: '#475467', lineHeight: 18 },
  environment: { fontSize: 13, fontWeight: '700', color: '#1F6FEB' },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: '#E4E7EC',
  },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#101828', letterSpacing: 0.4 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D0D5DD',
  },
  chipOn: { backgroundColor: '#101828', borderColor: '#101828' },
  chipText: { fontSize: 12, fontWeight: '600', color: '#344054' },
  chipTextOn: { color: '#FFFFFF' },
  input: {
    borderWidth: 1,
    borderColor: '#D0D5DD',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#101828',
    backgroundColor: '#FFFFFF',
  },
  label: { fontSize: 11, color: '#667085', textTransform: 'uppercase', letterSpacing: 0.5 },
  mono: { fontFamily: 'Courier', fontSize: 13, color: '#101828' },
  fact: { gap: 2, marginTop: 4 },
  factValue: { fontSize: 14, color: '#101828' },
  hint: { fontSize: 12, color: '#667085', lineHeight: 16 },
  button: {
    backgroundColor: '#1F6FEB',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 24,
    flexGrow: 1,
    alignItems: 'center',
  },
  buttonOff: { backgroundColor: '#98A2B3' },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  buttonAlt: {
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: '#D0D5DD',
    alignItems: 'center',
  },
  buttonAltText: { color: '#344054', fontWeight: '600', fontSize: 13 },
  spinner: { marginVertical: 8 },
  pill: { alignSelf: 'flex-start', borderRadius: 999, paddingVertical: 4, paddingHorizontal: 12 },
  pillText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
  pillWire: { backgroundColor: '#344054' },
  pillCache: { backgroundColor: '#0B7285' },
  pillPass: { backgroundColor: '#067647' },
  pillFail: { backgroundColor: '#B42318' },
  disclaimer: {
    marginTop: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#F79009',
    backgroundColor: '#FFFAEB',
    padding: 10,
    borderRadius: 6,
    gap: 4,
  },
  disclaimerLabel: { fontSize: 11, fontWeight: '700', color: '#B54708', letterSpacing: 0.5 },
  disclaimerText: { fontSize: 12, color: '#7A2E0E', lineHeight: 17 },
  failure: { fontSize: 12, color: '#B42318', lineHeight: 17 },
});
