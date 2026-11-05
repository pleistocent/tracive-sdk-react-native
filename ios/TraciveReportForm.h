#ifdef RCT_NEW_ARCH_ENABLED
#import <TraciveSdkReactNativeSpec/TraciveSdkReactNativeSpec.h>

@interface TraciveReportForm : NSObject <NativeTraciveReportFormSpec>
#else
#import <React/RCTBridgeModule.h>

@interface TraciveReportForm : NSObject <RCTBridgeModule>
#endif

@end
