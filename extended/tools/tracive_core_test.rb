# Runs with plain Ruby: ruby tools/tracive_core_test.rb
require 'digest'
require 'fileutils'
require 'minitest/autorun'
require 'stringio'
require 'tmpdir'
require_relative '../ios/tracive_core'

class TraciveCoreTest < Minitest::Test
  NAME = TraciveCore::NAME

  def setup
    @work = Dir.mktmpdir('tracive-core-test')
    @pod = File.join(@work, 'ios')
    FileUtils.mkdir_p(@pod)
    @built = File.join(@work, 'built', NAME)
    FileUtils.mkdir_p(File.join(@built, 'ios-arm64'))
    File.write(File.join(@built, 'Info.plist'), 'plist')
    @zip = File.join(@work, "#{NAME}.zip")
    Dir.chdir(File.dirname(@built)) { assert system('/usr/bin/zip', '-qr', @zip, NAME) }
    @destination = File.join(@pod, 'Frameworks', NAME)
    @url = "file://#{@zip}"
  end

  def teardown
    FileUtils.rm_rf(@work)
  end

  def pin(checksum)
    File.write(File.join(@pod, 'TraciveReportCore.sha256'), "#{checksum}\n")
  end

  def install(env: {})
    TraciveCore.install(pod_dir: @pod, version: '1.2.3', env: env)
  end

  def quietly
    out = $stdout
    $stdout = StringIO.new
    yield
  ensure
    $stdout = out
  end

  def test_a_matching_download_lands
    quietly { TraciveCore.fetch(@url, Digest::SHA256.file(@zip).hexdigest, @destination) }
    assert File.exist?(File.join(@destination, 'Info.plist'))
  end

  def test_a_mismatch_stops_the_install_and_leaves_nothing
    wrong = 'a' * 64
    error = assert_raises(RuntimeError) { quietly { TraciveCore.fetch(@url, wrong, @destination) } }
    assert_includes error.message, wrong
    assert_includes error.message, Digest::SHA256.file(@zip).hexdigest
    refute File.exist?(@destination)
  end

  def test_a_mismatch_keeps_what_was_there
    FileUtils.mkdir_p(@destination)
    File.write(File.join(@destination, 'Info.plist'), 'old')
    assert_raises(RuntimeError) { quietly { TraciveCore.fetch(@url, 'a' * 64, @destination) } }
    assert_equal 'old', File.read(File.join(@destination, 'Info.plist'))
  end

  def test_a_failed_download_is_loud
    error = assert_raises(RuntimeError) do
      quietly { TraciveCore.fetch("file://#{@work}/missing.zip", 'a' * 64, @destination) }
    end
    assert_includes error.message, 'curl'
  end

  def test_a_zip_without_the_framework_is_refused
    other = File.join(@work, 'other.zip')
    Dir.chdir(@work) { assert system('/usr/bin/zip', '-qr', other, 'ios') }
    checksum = Digest::SHA256.file(other).hexdigest
    error = assert_raises(RuntimeError) { quietly { TraciveCore.fetch("file://#{other}", checksum, @destination) } }
    assert_includes error.message, 'holds no'
  end

  def test_an_unpinned_version_names_the_way_out
    pin('unreleased')
    error = assert_raises(RuntimeError) { install }
    assert_includes error.message, TraciveCore::LOCAL_BUILD_VARIABLE
  end

  def test_a_finished_install_is_not_fetched_again
    checksum = Digest::SHA256.file(@zip).hexdigest
    pin(checksum)
    FileUtils.mkdir_p(@destination)
    File.write("#{@destination}.sha256", "#{checksum}\n")
    install
    assert File.directory?(@destination)
  end

  def test_a_local_build_wins_and_clears_the_stamp
    FileUtils.mkdir_p(File.dirname(@destination))
    File.write("#{@destination}.sha256", 'old')
    install(env: { TraciveCore::LOCAL_BUILD_VARIABLE => @built })
    assert File.exist?(File.join(@destination, 'Info.plist'))
    refute File.exist?("#{@destination}.sha256")
  end

  def test_a_local_path_that_is_no_framework_is_refused
    assert_raises(RuntimeError) { install(env: { TraciveCore::LOCAL_BUILD_VARIABLE => @work }) }
  end
end
