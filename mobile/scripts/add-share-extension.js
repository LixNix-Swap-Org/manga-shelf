#!/usr/bin/env node
// Adds the iOS share extension target ShareToMangaShelf to ios/App/App.xcodeproj with the xcodeproj gem that ships
// with CocoaPods, so the project change is reproducible and reviewable. Idempotent; the result is committed.
//   node scripts/add-share-extension.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { MOBILE_DIR } = require('./lib');

const IOS_DIR = path.join(MOBILE_DIR, 'ios', 'App');
const PROJECT = path.join(IOS_DIR, 'App.xcodeproj');
const SHARE_TARGET = 'ShareToMangaShelf';
const SHARE_BUNDLE_ID = 'de.mangashelf.app.ShareToMangaShelf';
const APP_GROUP = 'group.de.mangashelf.app';
const EMBED_PHASE = 'Embed Foundation Extensions';

const RUBY = `
require 'xcodeproj'
project = Xcodeproj::Project.open(ARGV[0])
target_name, bundle_id, embed_name = ARGV[1], ARGV[2], ARGV[3]
app = project.targets.find { |t| t.name == 'App' } or abort('App target missing')
if project.targets.any? { |t| t.name == target_name }
  puts 'present'
  exit 0
end
app_settings = app.build_configurations.first.build_settings
ext = project.new_target(:app_extension, target_name, :ios, app_settings['IPHONEOS_DEPLOYMENT_TARGET'], nil, :swift)
# new_target links Foundation by a path inside the current SDK version; Swift links it on its own
ext.frameworks_build_phase.files_references.each(&:remove_from_project)
project.frameworks_group.children.select { |g| g.is_a?(Xcodeproj::Project::Object::PBXGroup) && g.children.empty? }.each(&:remove_from_project)
group = project.main_group.new_group(target_name, target_name)
ext.add_file_references([group.new_reference('ShareViewController.swift')])
group.new_reference('Info.plist')
group.new_reference(target_name + '.entitlements')
ext.build_configurations.each do |config|
  app_config = app.build_configurations.find { |c| c.name == config.name }.build_settings
  s = config.build_settings
  s['PRODUCT_BUNDLE_IDENTIFIER'] = bundle_id
  s['PRODUCT_NAME'] = '$(TARGET_NAME)'
  s['INFOPLIST_FILE'] = target_name + '/Info.plist'
  s['CODE_SIGN_ENTITLEMENTS'] = target_name + '/' + target_name + '.entitlements'
  s['CODE_SIGN_STYLE'] = 'Automatic'
  s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  s['GENERATE_INFOPLIST_FILE'] = 'NO'
  s['IPHONEOS_DEPLOYMENT_TARGET'] = app_config['IPHONEOS_DEPLOYMENT_TARGET']
  s['MARKETING_VERSION'] = app_config['MARKETING_VERSION']
  s['CURRENT_PROJECT_VERSION'] = app_config['CURRENT_PROJECT_VERSION']
  s['SWIFT_VERSION'] = app_config['SWIFT_VERSION']
  s['TARGETED_DEVICE_FAMILY'] = app_config['TARGETED_DEVICE_FAMILY']
  s['LD_RUNPATH_SEARCH_PATHS'] = '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks'
  s['SKIP_INSTALL'] = 'YES'
end
app_group = project.main_group.children.find { |g| g.respond_to?(:path) && g.path == 'App' }
app_group.new_reference('App.entitlements')
app.build_configurations.each { |config| config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements' }
app.add_dependency(ext)
phase = app.new_copy_files_build_phase(embed_name)
phase.symbol_dst_subfolder_spec = :plug_ins
phase.dst_path = ''
build_file = phase.add_file_reference(ext.product_reference, true)
build_file.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
# before the CocoaPods script phases, which would otherwise form a build cycle with the embed step
app.build_phases.delete(phase)
resources = app.build_phases.index { |p| p.is_a?(Xcodeproj::Project::Object::PBXResourcesBuildPhase) }
app.build_phases.insert(resources + 1, phase)
project.save
puts 'added'
`;

/** A Ruby that can load xcodeproj: XCODEPROJ_RUBY, the PATH ruby, or the one behind Homebrew's pod wrapper. */
function findRuby(env = process.env) {
  const candidates = [];
  if (env.XCODEPROJ_RUBY) candidates.push({ ruby: env.XCODEPROJ_RUBY, env });
  candidates.push({ ruby: 'ruby', env });
  try {
    const pod = execFileSync('which', ['pod'], { encoding: 'utf-8' }).trim();
    const wrapper = fs.readFileSync(pod, 'utf-8');
    const gemHome = /GEM_HOME="([^"]+)"/.exec(wrapper)?.[1];
    if (gemHome) {
      const shebang = fs.readFileSync(path.join(gemHome, 'bin', 'pod'), 'utf-8').split('\n')[0];
      const ruby = shebang.replace(/^#!\s*/, '').trim().split(/\s+/)[0];
      candidates.push({ ruby, env: { ...env, GEM_HOME: gemHome } });
    }
  } catch (_) { /* no Homebrew pod wrapper */ }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.ruby, ['-e', "require 'xcodeproj'"], { env: candidate.env, stdio: 'ignore' });
      return candidate;
    } catch (_) { /* next */ }
  }
  throw new Error('Keine Ruby-Installation mit dem xcodeproj-Gem gefunden (CocoaPods installieren oder XCODEPROJ_RUBY setzen)');
}

function addShareExtension({ env = process.env } = {}) {
  for (const file of ['ShareViewController.swift', 'Info.plist', `${SHARE_TARGET}.entitlements`]) {
    if (!fs.existsSync(path.join(IOS_DIR, SHARE_TARGET, file))) throw new Error(`${SHARE_TARGET}/${file} fehlt`);
  }
  const { ruby, env: rubyEnv } = findRuby(env);
  const out = execFileSync(ruby, ['-e', RUBY, PROJECT, SHARE_TARGET, SHARE_BUNDLE_ID, EMBED_PHASE],
    { env: { ...rubyEnv, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }, encoding: 'utf-8' });
  return out.trim().split('\n').pop();
}

module.exports = { SHARE_TARGET, SHARE_BUNDLE_ID, APP_GROUP, EMBED_PHASE, addShareExtension };

if (require.main === module) {
  try {
    const state = addShareExtension();
    console.log(state === 'present' ? `[mobile] ${SHARE_TARGET} ist schon im Xcode-Projekt` : `[mobile] ${SHARE_TARGET} hinzugefügt`);
  } catch (err) {
    console.error(`[mobile] ${err.message}`);
    process.exit(1);
  }
}
