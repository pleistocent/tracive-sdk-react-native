import Constants from 'expo-constants';
import { ReportFormTarget, TraciveEnvironment } from '@pleistocent/tracive-sdk-react-native';

interface ExampleExtra {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly baseUrl?: string;
  readonly appScheme?: string;
  readonly token?: string;
}

const extra = Constants.expoConfig?.extra?.tracive as ExampleExtra;

export const clientId = extra.clientId;
export const redirectUri = extra.redirectUri;

/** Set when tracive.local.json names a made-up token: no grant, no Tracive app. */
export const localToken = extra.token;

export const environment: TraciveEnvironment =
  extra.baseUrl === undefined
    ? TraciveEnvironment.sandbox
    : TraciveEnvironment.custom(extra.baseUrl);

/** The Tracive build `openInTracive` opens. Undefined follows `environment`. */
export const target: ReportFormTarget | undefined =
  extra.appScheme === undefined
    ? undefined
    : // Only the scheme is read here: this example never hands over a package.
      ReportFormTarget.custom({
        ...ReportFormTarget.production,
        scheme: extra.appScheme,
      });
