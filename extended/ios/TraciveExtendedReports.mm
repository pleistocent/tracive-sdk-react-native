#import "TraciveExtendedReports.h"

#import <Security/SecRandom.h>

#if __has_include(<TraciveSdkExtendedReactNative/TraciveSdkExtendedReactNative-Swift.h>)
#import <TraciveSdkExtendedReactNative/TraciveSdkExtendedReactNative-Swift.h>
#else
#import "TraciveSdkExtendedReactNative-Swift.h"
#endif

static NSString *const kTokenEvent = @"TraciveReports.accessToken";
static NSString *const kProgressEvent = @"TraciveReports.progress";

@implementation TraciveExtendedReports {
  TraciveReportsBridge *_reports;
}

RCT_EXPORT_MODULE(TraciveExtendedReports)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

// The bridge keeps its state on the main queue and presents UIKit screens from it.
- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[ kTokenEvent, kProgressEvent ];
}

- (TraciveReportsBridge *)reportsBridge
{
  if (_reports == nil) {
    __weak TraciveExtendedReports *weakSelf = self;
    _reports = [[TraciveReportsBridge alloc] initWithEmit:^(NSString *event, NSDictionary *body) {
      [weakSelf sendEventWithName:event body:body];
    }];
  }
  return _reports;
}

- (void)invalidate
{
  [_reports invalidate];
  [super invalidate];
}

static void (^rejecting(RCTPromiseRejectBlock reject))(NSString *, NSString *, NSDictionary *)
{
  return ^(NSString *code, NSString *message, NSDictionary *details) {
    reject(code, message, [NSError errorWithDomain:@"TraciveReports" code:0 userInfo:details]);
  };
}

RCT_EXPORT_METHOD(create
                  : (NSString *)baseUrl appUrlScheme
                  : (NSString *)appUrlScheme resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] createWithBaseUrl:baseUrl
                             appUrlScheme:appUrlScheme
                                  resolve:resolve
                                   reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(dispose
                  : (double)reports resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] disposeWithReports:reports];
  resolve(nil);
}

- (NSString *)idempotencyKey
{
  uint8_t bytes[16];
  if (SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes) != errSecSuccess) {
    arc4random_buf(bytes, sizeof(bytes));
  }
  NSMutableString *key = [NSMutableString stringWithCapacity:sizeof(bytes) * 2];
  for (size_t i = 0; i < sizeof(bytes); i++) {
    [key appendFormat:@"%02x", bytes[i]];
  }
  return key;
}

RCT_EXPORT_METHOD(requirements
                  : (double)reports call
                  : (double)call resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] requirementsWithReports:reports
                                           call:call
                                        resolve:resolve
                                         reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(prepare
                  : (double)reports call
                  : (double)call source
                  : (NSDictionary *)source resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] prepareWithReports:reports
                                      call:call
                                    source:source
                                   resolve:resolve
                                    reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(releaseEvidence : (double)reports evidence : (double)evidence)
{
  [[self reportsBridge] releaseEvidenceWithReports:reports evidence:evidence];
}

RCT_EXPORT_METHOD(submit
                  : (double)reports call
                  : (double)call draft
                  : (NSDictionary *)draft resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] submitWithReports:reports
                                     call:call
                                    draft:draft
                                  resolve:resolve
                                   reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(status
                  : (double)reports call
                  : (double)call reportId
                  : (NSString *)reportId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] statusWithReports:reports
                                     call:call
                                 reportId:reportId
                                  resolve:resolve
                                   reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(cancel : (double)reports call : (double)call)
{
  [[self reportsBridge] cancelWithReports:reports call:call];
}

RCT_EXPORT_METHOD(openInTracive
                  : (double)reports reportId
                  : (NSString *)reportId resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] openInTraciveWithReports:reports
                                        reportId:reportId
                                         resolve:resolve
                                          reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(presentForm
                  : (double)reports request
                  : (NSDictionary *)request resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] presentFormWithReports:reports
                                       request:request
                                       resolve:resolve
                                        reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(presentStatus
                  : (double)reports request
                  : (NSDictionary *)request resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject)
{
  [[self reportsBridge] presentStatusWithReports:reports
                                         request:request
                                         resolve:resolve
                                          reject:rejecting(reject)];
}

RCT_EXPORT_METHOD(answerToken : (double)request token : (NSString *)token)
{
  [[self reportsBridge] answerTokenWithRequest:request token:token];
}

RCT_EXPORT_METHOD(failToken : (double)request failure : (NSDictionary *)failure)
{
  [[self reportsBridge] failTokenWithRequest:request failure:failure];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeTraciveReportsSpecJSI>(params);
}

@end
