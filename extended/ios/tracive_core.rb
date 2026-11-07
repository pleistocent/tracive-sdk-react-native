require 'digest'
require 'fileutils'
require 'tmpdir'

# Puts TraciveReportCore.xcframework in `ios/Frameworks`. The podspec calls this while CocoaPods reads
# it: a Flutter plugin is a path pod, and `prepare_command` does not run for one.
module TraciveCore
  NAME = 'TraciveReportCore.xcframework'.freeze
  LOCAL_BUILD_VARIABLE = 'TRACIVE_EXTENDED_XCFRAMEWORK'.freeze
  RELEASES = 'https://github.com/pleistocent/tracive-sdk-swift/releases/download'.freeze

  def self.install(pod_dir:, version:, env: ENV)
    destination = File.join(pod_dir, 'Frameworks', NAME)
    stamp = "#{destination}.sha256"
    local = env[LOCAL_BUILD_VARIABLE].to_s
    unless local.empty?
      FileUtils.rm_f(stamp)
      return copy_local(local, destination)
    end

    checksum = File.read(File.join(pod_dir, 'TraciveReportCore.sha256')).strip
    unless checksum.match?(/\A\h{64}\z/)
      raise "tracive_sdk_extended #{version} pins no #{NAME}: ios/TraciveReportCore.sha256 holds " \
            "\"#{checksum}\". For a local build, set #{LOCAL_BUILD_VARIABLE} to its path."
    end
    return if File.directory?(destination) && File.exist?(stamp) && File.read(stamp).strip == checksum

    fetch("#{RELEASES}/#{version}/#{NAME}.zip", checksum, destination)
    File.write(stamp, "#{checksum}\n")
  end

  def self.copy_local(source, destination)
    unless File.exist?(File.join(source, 'Info.plist'))
      raise "#{LOCAL_BUILD_VARIABLE} is not an XCFramework: #{source}"
    end

    FileUtils.mkdir_p(destination)
    run('/usr/bin/rsync', '-a', '--delete', "#{source}/", "#{destination}/")
  end

  def self.fetch(url, checksum, destination)
    Dir.mktmpdir('tracive-core') do |work|
      zip = File.join(work, "#{NAME}.zip")
      puts "tracive_sdk_extended: fetching #{url}"
      run('/usr/bin/curl', '--fail', '--location', '--silent', '--show-error', '--retry', '3',
          '--output', zip, url)

      actual = Digest::SHA256.file(zip).hexdigest
      unless actual == checksum
        raise "tracive_sdk_extended: refusing #{url}: its SHA-256 is #{actual}, and " \
              "ios/TraciveReportCore.sha256 pins #{checksum}."
      end

      run('/usr/bin/unzip', '-q', zip, '-d', work)
      unpacked = File.join(work, NAME)
      raise "tracive_sdk_extended: #{url} holds no #{NAME}." unless File.directory?(unpacked)

      FileUtils.rm_rf(destination)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.mv(unpacked, destination)
    end
  end

  def self.run(*command)
    return if system(*command)

    raise "tracive_sdk_extended: this failed (#{$?.exitstatus}): #{command.join(' ')}"
  end
end
