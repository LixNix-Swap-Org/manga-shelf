require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'MangashelfNative'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'UNLICENSED', :text => 'Part of Manga Shelf' }
  s.homepage = 'https://github.com/LixNix-Swap-Org/manga-shelf'
  s.author = package['author']
  s.source = { :path => '.' }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '15.5'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
