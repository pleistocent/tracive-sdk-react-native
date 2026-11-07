/**
 * A runnable example for `@pleistocent/tracive-sdk-extended-react-native`: Tracive's form, your own
 * UI and the status screen, in Tracive's sandbox.
 *
 * Everything you must supply is marked `TODO(partner)`: `grep -rn "TODO(partner)" .`
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import {
  TraciveClient,
  TraciveMode,
  TraciveOAuth,
  TraciveQuery,
  type AuthResult,
  type OAuthConfiguration,
} from '@pleistocent/tracive-sdk-react-native';
import {
  expoRandom,
  expoSecurePendingAuthorizationStore,
  expoSecureTokenStore,
} from '@pleistocent/tracive-sdk-react-native/expo';
import {
  isTraciveReportException,
  ReportDraft,
  ReportPrefill,
  TraciveReportForm,
  TraciveReportScopes,
  TraciveReports,
  TraciveReportStatus,
  type RequiredTerm,
  type TraciveReportTheme,
} from '@pleistocent/tracive-sdk-extended-react-native';

import { clientId, environment, localToken, redirectUri, target } from './src/environment';
import { SAMPLE_RECEIPT_BASE64 } from './src/sampleReceipt';

// A made-up account, so the example runs with one tap and reports nobody real.
const FAKE_SCAMMER = TraciveQuery.bankAccount({
  countryAlpha3: 'IDN',
  bankCode: 'BCA',
  account: '0000000001',
});

const THEME: TraciveReportTheme = { primaryColor: '#00695C', cornerRadius: 16 };

const OAUTH: OAuthConfiguration = {
  clientId,
  redirectUri,
  // TODO(partner): your own stable id for this user, never a phone number or an email.
  partnerUserId: 'partner-user-1',
  scopes: [TraciveReportScopes.create, TraciveReportScopes.read],
};

function openClient(): TraciveClient {
  const oauth = new TraciveOAuth({
    mode: OAUTH,
    environment,
    tokenStore: expoSecureTokenStore(),
    pendingStore: expoSecurePendingAuthorizationStore(),
    random: expoRandom,
  });
  return new TraciveClient({
    mode: TraciveMode.oauth(OAUTH),
    environment,
    oauth,
    random: expoRandom,
  });
}

function openReports(client: TraciveClient | undefined): TraciveReports {
  if (client !== undefined) return new TraciveReports({ client, target });
  return new TraciveReports({
    environment,
    target,
    accessToken: async () => localToken as string,
  });
}

function yesterday(): string {
  const date = new Date(Date.now() - 86_400_000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** A file on disk, because `prepare` reads a URI natively and no bytes cross the bridge. */
function receiptFile(): string {
  const file = new File(Paths.cache, 'tracive-example-receipt.png');
  file.write(SAMPLE_RECEIPT_BASE64, { encoding: 'base64' });
  return file.uri;
}

function authMessage(result: AuthResult | null): string {
  if (result === null) return 'Consent opened. Finish it in the Tracive app.';
  switch (result.type) {
    case 'authorized':
      return `Granted: ${result.grantedScopes.join(', ')}`;
    case 'appNotInstalled':
      return 'Install Tracive first. Its page was opened.';
    case 'denied':
      return 'You declined.';
    case 'failed':
      return `Authorize failed: ${result.error.message}`;
    default:
      return `Unexpected: ${result.type}`;
  }
}

function Button(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly quiet?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.button,
        props.quiet === true && styles.quietButton,
        props.disabled === true && styles.buttonOff,
      ]}
    >
      <Text style={props.quiet === true ? styles.quietButtonText : styles.buttonText}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export default function App() {
  const client = useRef(localToken === undefined ? openClient() : undefined).current;
  const reports = useRef(openReports(client)).current;
  // TODO(partner): the user writes this. A chronology is their own account of what happened, and
  // your own UI must not fill it in.
  const [chronology, setChronology] = useState(
    'Example only: I paid for a phone, and the seller stopped answering my messages the same day.',
  );
  const ownDraft = useRef<ReportDraft | undefined>(undefined);
  const [message, setMessage] = useState('Ready.');
  const [lastReportId, setLastReportId] = useState<string | undefined>();
  const [terms, setTerms] = useState<readonly RequiredTerm[]>([]);
  const [progress, setProgress] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (client === undefined) return undefined;
    const stopResults = client.onAuthResult((result) => setMessage(authMessage(result)));
    const stopLinks = client.startLinkListener();
    return () => {
      stopLinks();
      stopResults();
    };
  }, [client]);

  async function guarded(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      if (!isTraciveReportException(failure)) throw failure;
      setMessage(
        failure.code === 'NEEDS_CONSENT'
          ? 'Needs consent. Authorize first.'
          : `Failed: ${failure.code}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const authorize = () => guarded(async () => setMessage(authMessage(await client!.authorize())));

  const openForm = () =>
    guarded(async () => {
      const outcome = await TraciveReportForm.present(reports, {
        prefill: ReportPrefill.forQuery(FAKE_SCAMMER, {
          incidentDate: yesterday(),
          title: 'Example: fake seller',
          attachments: [{ uri: receiptFile(), mimeType: 'image/png' }],
        }),
        theme: THEME,
      });
      if (outcome.type === 'submitted') {
        setLastReportId(outcome.reportId);
        setMessage(`Form: submitted ${outcome.reportId}, ${outcome.status}`);
      } else if (outcome.type === 'needsConsent') {
        setMessage('Form: needs consent. Authorize, then open it again.');
      } else {
        setMessage('Form: cancelled.');
      }
    });

  const sendWithOwnUi = () =>
    guarded(async () => {
      const requirements = await reports.requirements();
      setTerms(requirements.terms);

      const draft =
        ownDraft.current?.chronology === chronology
          ? ownDraft.current
          : ReportDraft.forQuery(FAKE_SCAMMER, {
              title: 'Example: own UI',
              chronology,
              incidentDate: yesterday(),
              evidence: [await reports.prepare({ uri: receiptFile(), mimeType: 'image/png' })],
              acceptedTerms: requirements.terms,
            });
      ownDraft.current = draft;

      const problems = draft.problems(requirements.limits);
      if (problems.length > 0) {
        setMessage(`Fix first: ${problems.join(', ')}`);
        return;
      }

      const result = await reports.submit(draft, { onProgress: setProgress });
      setProgress(undefined);
      if (result.type === 'submitted') {
        ownDraft.current = undefined;
        setLastReportId(result.reportId);
        setMessage(`Own UI: submitted ${result.reportId}, ${result.status}`);
      } else if (result.type === 'needsConsent') {
        setMessage('Own UI: needs consent. Authorize, then try again.');
      } else {
        const { code, retryAfterSeconds } = result.error;
        const wait = retryAfterSeconds === undefined ? '' : ` Wait ${retryAfterSeconds} s.`;
        setMessage(`Own UI failed: ${code}.${wait} Try again.`);
      }
    });

  const openStatus = () =>
    guarded(async () => {
      const outcome = await TraciveReportStatus.present(reports, {
        reportId: lastReportId as string,
        theme: THEME,
      });
      setMessage(`Status screen: ${outcome.type}`);
    });

  const checkStatus = () =>
    guarded(async () => {
      setMessage(`Own UI: status is ${await reports.status(lastReportId as string)}`);
    });

  const openInTracive = () =>
    guarded(async () => {
      const opened = await reports.openInTracive(lastReportId as string);
      setMessage(opened ? 'Opened in Tracive.' : 'Tracive is not installed.');
    });

  const hasReport = lastReportId !== undefined && !busy;

  return (
    <View style={styles.screen}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Tracive reports</Text>
        <Text testID="message" style={styles.message}>
          {message}
        </Text>

        {client !== undefined && (
          <Button label="Authorize" onPress={authorize} disabled={busy} quiet />
        )}
        <Button label="Report on Tracive's form" onPress={openForm} disabled={busy} />

        <View style={styles.divider} />

        <Text style={styles.label}>Your own UI: what happened</Text>
        <TextInput multiline value={chronology} onChangeText={setChronology} style={styles.input} />
        {progress !== undefined && (
          <Text style={styles.small}>Uploading: {Math.round(progress * 100)}%</Text>
        )}
        {/* TODO(partner): your own UI must show these next to Send. */}
        {terms.map((term) => (
          <Text key={term.id} style={styles.small}>
            {term.id}: {term.url}
          </Text>
        ))}
        <Button label="Report on your own UI" onPress={sendWithOwnUi} disabled={busy} />

        <View style={styles.divider} />

        <Text style={styles.label}>Last report: {lastReportId ?? 'none yet'}</Text>
        <Button
          label="Status on Tracive's screen"
          onPress={openStatus}
          disabled={!hasReport}
          quiet
        />
        <Button label="Status on your own UI" onPress={checkStatus} disabled={!hasReport} quiet />
        <Button label="Open in Tracive" onPress={openInTracive} disabled={!hasReport} quiet />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { padding: 16, paddingTop: 64, gap: 10 },
  title: { fontSize: 22, fontWeight: '600', color: '#111111' },
  message: { fontSize: 15, color: '#333333', marginBottom: 8 },
  label: { fontSize: 14, color: '#333333' },
  small: { fontSize: 12, color: '#555555' },
  input: {
    borderWidth: 1,
    borderColor: '#BBBBBB',
    borderRadius: 8,
    padding: 10,
    minHeight: 84,
    textAlignVertical: 'top',
    color: '#111111',
  },
  divider: { height: 1, backgroundColor: '#E2E2E2', marginVertical: 10 },
  button: {
    backgroundColor: '#00695C',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonOff: { opacity: 0.4 },
  buttonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' },
  quietButton: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#00695C' },
  quietButtonText: { color: '#00695C', fontSize: 15, fontWeight: '600' },
});
