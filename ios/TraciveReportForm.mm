#import "TraciveReportForm.h"

#import <React/RCTUtils.h>

#if __has_include(<TraciveSdkReactNative/TraciveSdkReactNative-Swift.h>)
#import <TraciveSdkReactNative/TraciveSdkReactNative-Swift.h>
#else
#import "TraciveSdkReactNative-Swift.h"
#endif

static NSString *const kErrorCode = @"E_TRACIVE_REPORT_FORM";

@implementation TraciveReportForm {
  TraciveReportFormPresenter *_presenter;
}

@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;

RCT_EXPORT_MODULE(TraciveReportForm)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// Every method touches UIKit or answers at once, so all of them run on the main queue.
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

RCT_EXPORT_METHOD(presentPackage
                  : (NSString *)packageJson fileName
                  : (NSString *)fileName anchorTag
                  : (double)anchorTag resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  if (_presenter == nil) {
    _presenter = [TraciveReportFormPresenter new];
  }
  UIView *anchor = anchorTag > 0 ? [self.viewRegistry_DEPRECATED viewForReactTag:@(anchorTag)] : nil;
  [_presenter presentWithPackageJson:packageJson
      fileName:fileName
      anchor:anchor
      fallback:RCTPresentedViewController()
      completion:^(NSString *bundleId) {
        resolve(bundleId);
      }
      failure:^(NSString *code) {
        reject(kErrorCode, [@"The Open in sheet could not be presented: " stringByAppendingString:code], nil);
      }];
}

RCT_EXPORT_METHOD(isAppInstalled
                  : (NSString *)androidPackage resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  reject(kErrorCode, @"isAppInstalled is Android only.", nil);
}

RCT_EXPORT_METHOD(deliverPackage
                  : (NSString *)packageJson androidPackage
                  : (NSString *)androidPackage mimeType
                  : (NSString *)mimeType resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  reject(kErrorCode, @"deliverPackage is Android only.", nil);
}

RCT_EXPORT_METHOD(openLink
                  : (NSString *)url androidPackage
                  : (NSString *)androidPackage resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  reject(kErrorCode, @"openLink is Android only.", nil);
}

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeTraciveReportFormSpecJSI>(params);
}
#endif

@end
