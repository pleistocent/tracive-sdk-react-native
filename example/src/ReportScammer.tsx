/**
 * "Report a scammer" from a transaction detail screen: what a bank or wallet app shows after a
 * transfer, with a button that opens the Tracive report form already filled in.
 *
 * `openReportForm` needs no grant and no network, so this works in every flavor, the offline demo
 * included. It does need the Tracive app on the device: the sandbox build by default, or the
 * production or dev build through the picker.
 */
import { useCallback, useRef, useState } from 'react';
import { findNodeHandle, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  ReportAttachment,
  ReportFormTarget,
  TraciveQuery,
  type ReportFormResult,
  type TraciveClient,
} from '@pleistocent/tracive-sdk-react-native';

import { receiptPdf, receiptPng } from './receipt';

// The dev build is a Tracive QA build the SDK deliberately does not know, so it goes through the
// explicit target. Its package is made visible in android/app/src/main/AndroidManifest.xml and its
// schemes are listed in ios/TraciveRN/Info.plist, both written by plugins/withTraciveDevBuild.js.
const TARGETS = [
  { key: 'sandbox', label: 'Sandbox', target: ReportFormTarget.sandbox },
  { key: 'production', label: 'Production', target: ReportFormTarget.production },
  {
    key: 'dev',
    label: 'Dev build (QA)',
    target: ReportFormTarget.custom({
      androidPackage: 'com.pleistocent.tracive.dev',
      iosBundleId: 'com.pleistocent.tracive.dev',
      scheme: 'tracivedev',
      reportScheme: 'tracivedev-report',
      fileExtension: 'tracivedevreport',
    }),
  },
] as const;
type TargetKey = (typeof TARGETS)[number]['key'];

// TODO(partner): your own transaction. The recipient account is what gets reported.
const TRANSACTION = {
  amount: 'Rp 2.500.000',
  bank: 'BCA',
  account: '1234567890',
  recipient: 'Sample Recipient',
  reference: 'TRF2611030001',
};

/** The local calendar date one day back, as the transaction date a user would have seen. */
function yesterday(): { iso: string; label: string } {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    iso: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    label: date.toDateString(),
  };
}

function describe(result: ReportFormResult): string {
  switch (result.type) {
    case 'opened':
      return result.attachmentsDelivered
        ? 'Opened: the form has the account, the date and both receipts.'
        : 'Opened, identifier only: this Tracive build is too old to take the date and the files.';
    case 'cancelled':
      return 'Cancelled: the sheet was closed, or the file went to another app.';
    case 'installPageOpened':
      return 'Tracive is not installed; the install page was opened.';
    case 'failed':
      return `Failed: ${result.error.code}${'message' in result.error ? ` · ${result.error.message}` : ''}`;
  }
}

export function ReportScammer({ client }: { client: TraciveClient | undefined }) {
  const [targetKey, setTargetKey] = useState<TargetKey>('sandbox');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | undefined>();
  const button = useRef<View>(null);
  const date = yesterday();

  const report = useCallback(async () => {
    if (client === undefined) return;
    setBusy(true);
    setOutcome(undefined);
    try {
      const query = TraciveQuery.bankAccount({
        countryAlpha3: 'IDN',
        bankCode: TRANSACTION.bank,
        account: TRANSACTION.account,
      });
      const receipt = [
        'Transfer receipt',
        `Amount: ${TRANSACTION.amount}`,
        `Date: ${date.iso}`,
        `To: ${TRANSACTION.bank} ${TRANSACTION.account} (${TRANSACTION.recipient})`,
        `Reference: ${TRANSACTION.reference}`,
      ];
      const result = await client.openReportForm(query, {
        incidentDate: date.iso,
        attachments: [
          ReportAttachment.image(receiptPng(), 'image/png'),
          ReportAttachment.pdf(receiptPdf(receipt)),
        ],
        anchor: findNodeHandle(button.current),
        target: TARGETS.find((entry) => entry.key === targetKey)?.target,
      });
      setOutcome(describe(result));
    } catch (cause) {
      setOutcome(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [client, date.iso, targetKey]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>5 · Report a scammer, from a transaction</Text>
      <Text style={styles.amount}>{TRANSACTION.amount}</Text>
      <Text style={styles.line}>{date.label}</Text>
      <Text style={styles.line}>
        To {TRANSACTION.recipient} · {TRANSACTION.bank} {TRANSACTION.account}
      </Text>
      <Text style={styles.line}>Ref {TRANSACTION.reference}</Text>

      <Text style={styles.label}>Tracive build</Text>
      <View style={styles.row}>
        {TARGETS.map((entry) => (
          <Pressable
            key={entry.key}
            onPress={() => setTargetKey(entry.key)}
            style={[styles.chip, targetKey === entry.key && styles.chipOn]}
          >
            <Text style={[styles.chipText, targetKey === entry.key && styles.chipTextOn]}>
              {entry.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        ref={button}
        onPress={report}
        disabled={busy || client === undefined}
        style={[styles.button, (busy || client === undefined) && styles.buttonOff]}
      >
        <Text style={styles.buttonText}>{busy ? 'Opening…' : 'Report'}</Text>
      </Pressable>
      <Text style={styles.hint}>
        Opens Tracive's report form with this account, yesterday's date and a PNG and a PDF receipt
        made in code. No grant, no network, no credit.
      </Text>
      {outcome !== undefined ? <Text style={styles.outcome}>{outcome}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: '#E4E7EC',
  },
  cardTitle: { fontSize: 13, fontWeight: '700', color: '#101828', letterSpacing: 0.4 },
  amount: { fontSize: 24, fontWeight: '700', color: '#101828' },
  line: { fontSize: 13, color: '#344054' },
  label: {
    fontSize: 11,
    color: '#667085',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 4,
  },
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
  button: {
    backgroundColor: '#B42318',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonOff: { backgroundColor: '#98A2B3' },
  buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  hint: { fontSize: 12, color: '#667085', lineHeight: 16 },
  outcome: { fontSize: 13, color: '#101828', lineHeight: 18 },
});
