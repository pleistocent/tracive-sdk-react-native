import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * The native half of `openReportForm`. Codegen reads this file, so its shape is the contract with
 * `android/` and `ios/`. Each platform rejects the other platform's methods.
 */
export interface Spec extends TurboModule {
  /** Android. Needs the host manifest to make the package visible. */
  isAppInstalled(androidPackage: string): Promise<boolean>;
  /**
   * Android. Replaces whatever an earlier call left in the SDK's cache folder, serves the file
   * from the SDK's FileProvider and starts it in `androidPackage`. False when nothing there
   * accepts the type (an older Tracive build); the file is then deleted again.
   */
  deliverPackage(packageJson: string, androidPackage: string, mimeType: string): Promise<boolean>;
  /** Android. An explicit-package VIEW intent. False when nothing in that package resolves it. */
  openLink(url: string, androidPackage: string): Promise<boolean>;
  /**
   * iOS. Writes `fileName` to a fresh temporary folder and presents the "Open in" sheet, anchored
   * to the view with React tag `anchorTag` (or the top view controller when it is -1). Resolves
   * with the bundle id of the app the user sent the file to, or `''` when the sheet was dismissed
   * without sending.
   */
  presentPackage(packageJson: string, fileName: string, anchorTag: number): Promise<string>;
}

export default TurboModuleRegistry.get<Spec>('TraciveReportForm');
