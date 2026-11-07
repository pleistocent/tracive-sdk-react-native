require "json"
load File.join(__dir__, "ios", "tracive_core.rb")

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

TraciveCore.install(pod_dir: File.join(__dir__, "ios"), version: package["version"])

# React Native's own pods raise this past 15 on their own schedule, and a pod may not sit below what
# it depends on.
ios_floor = [min_ios_version_supported, "15.0"].max_by { |version| Gem::Version.new(version) }

Pod::Spec.new do |s|
  s.name         = "TraciveSdkExtendedReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = "Tracive"
  s.platforms    = { :ios => ios_floor }
  s.source       = { :git => "https://github.com/pleistocent/tracive-sdk-react-native.git", :tag => "v#{s.version}" }

  s.source_files = "ios/*.{h,mm,swift}", "ios/Synced/**/*.swift"
  # The header imports the generated C++ spec; it must stay out of the Swift module's umbrella.
  s.private_header_files = "ios/*.h"
  s.resource_bundles = {
    "TraciveSDKExtended" => ["ios/Resources/Privacy/PrivacyInfo.xcprivacy"],
    "TraciveSDKExtendedUI" => ["ios/Resources/Strings/*.lproj"],
  }
  s.vendored_frameworks = "ios/Frameworks/#{TraciveCore::NAME}"
  s.swift_version = "5.9"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)
end
