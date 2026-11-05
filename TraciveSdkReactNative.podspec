require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "TraciveSdkReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = "Tracive"
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/pleistocent/tracive-sdk-react-native.git", :tag => "v#{s.version}" }

  s.source_files = "ios/**/*.{h,mm,swift}"
  # The header imports the generated C++ spec; it must stay out of the Swift module's umbrella.
  s.private_header_files = "ios/**/*.h"
  s.swift_version = "5.9"
  s.pod_target_xcconfig = { "DEFINES_MODULE" => "YES" }

  install_modules_dependencies(s)
end
