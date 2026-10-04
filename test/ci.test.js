// GitHub Actions workflows: they parse, every job pins its token permissions, actions are pinned
// by commit, only release.yml can write, signing steps only run with their secrets, calls match the called workflows.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function loadYaml() {
    for (const base of [path.join(__dirname, '..'), path.join(__dirname, '..', 'frontend')]) {
        try {
            return require(require.resolve('js-yaml', { paths: [base] }));
        } catch (e) { /* next */ }
    }
    throw new Error('js-yaml nicht gefunden (npm ci)');
}

const yaml = loadYaml();
const dir = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f));
const workflows = Object.fromEntries(files.map(f => [f, yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'))]));
const source = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const jobsOf = (f) => Object.entries(workflows[f].jobs);
const WRITE_PERMISSIONS = /^(write)$/;

function permissionsOf(f, job) {
    return { ...(workflows[f].permissions || {}), ...(job.permissions || {}) };
}

function* steps() {
    for (const f of files) {
        for (const [name, job] of jobsOf(f)) {
            for (const step of job.steps || []) yield { f, name, job, step };
        }
    }
}

describe('workflows', () => {
    test('the four distribution workflows exist and parse', () => {
        for (const f of ['ci.yml', 'build.yml', 'release.yml', 'mobile.yml']) assert.ok(workflows[f], `${f} fehlt`);
        assert.ok(!fs.existsSync(path.join(__dirname, '..', 'deploy')), 'the old deploy/ draft is gone');
    });

    test('every workflow defaults to a read-only token and every job pins its permissions', () => {
        for (const f of files) {
            const top = workflows[f].permissions;
            assert.ok(top && typeof top === 'object', `${f}: no top-level permissions`);
            for (const [scope, value] of Object.entries(top)) {
                if (f !== 'codeql.yml') assert.notEqual(value, 'write', `${f}: top-level ${scope}: write`);
            }
            if (f === 'codeql.yml' || f === 'ci.yml') continue;
            for (const [name, job] of jobsOf(f)) assert.ok(job.permissions, `${f} job ${name} has no permissions block`);
        }
    });

    test('only release.yml can write: contents for the tag and the release, packages for GHCR', () => {
        const writers = [];
        for (const f of files) {
            if (f === 'codeql.yml') continue;
            for (const [name, job] of jobsOf(f)) {
                for (const [scope, value] of Object.entries(permissionsOf(f, job))) {
                    if (WRITE_PERMISSIONS.test(value)) writers.push(`${f}:${name}:${scope}`);
                }
            }
        }
        assert.deepEqual(writers.sort(), ['release.yml:docker:id-token', 'release.yml:docker:packages', 'release.yml:publish:contents', 'release.yml:publish:packages', 'release.yml:tag:contents']);
    });

    test('release.yml runs only from the Actions tab with action build|release and a bump', () => {
        const on = workflows['release.yml'].on;
        assert.deepEqual(Object.keys(on), ['workflow_dispatch']);
        assert.deepEqual(on.workflow_dispatch.inputs.action.options, ['build', 'release']);
        assert.deepEqual(on.workflow_dispatch.inputs.bump.options, ['patch', 'minor', 'major', 'none']);
        for (const name of ['tag', 'docker', 'publish']) {
            assert.equal(workflows['release.yml'].jobs[name].if, "inputs.action == 'release'", `${name} must only run for action release`);
        }
    });

    test('ci.yml builds on every branch push, calls build.yml without publishing and keeps its jobs', () => {
        const ci = workflows['ci.yml'];
        assert.deepEqual(ci.on.push.branches, ['**']);
        assert.ok('pull_request' in ci.on);
        for (const job of ['test', 'frontend', 'package', 'docker', 'browser']) assert.ok(ci.jobs[job], `ci.yml lost the ${job} job`);
        assert.equal(ci.jobs.build.uses, './.github/workflows/build.yml');
        assert.equal(ci.jobs.build.with.publish, false);
        assert.ok(!('secrets' in ci.jobs.build), 'CI builds stay unsigned');
    });

    test('the backend test job installs the frontend so the core adapter tests fail instead of skipping', () => {
        const stepsText = JSON.stringify(workflows['ci.yml'].jobs.test.steps);
        assert.match(stepsText, /"working-directory":"frontend"/);
        assert.match(stepsText, /test\/core\/adapters\.test\.js test\/core\/takeover\.test\.js/);
        assert.match(stepsText, /skip\(ped\)\? 0/);
    });

    test('actions are pinned to a full commit SHA', () => {
        for (const { f, name, step } of steps()) {
            if (!step.uses || f === 'codeql.yml') continue;
            assert.match(step.uses, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${f} ${name}: ${step.uses}`);
        }
    });

    test('every job that runs on a runner has a timeout', () => {
        for (const f of files) {
            if (f === 'codeql.yml') continue;
            for (const [name, job] of jobsOf(f)) {
                if (job['runs-on']) assert.ok(job['timeout-minutes'] > 0, `${f} job ${name} has no timeout-minutes`);
            }
        }
    });

    test('steps that use signing secrets only run when the detection step found them', () => {
        const signingSecret = /secrets\.(WIN_CSC_LINK|MAC_CSC_LINK)\b/;
        for (const { f, name, step } of steps()) {
            const env = JSON.stringify(step.env || {});
            if (!signingSecret.test(env) || /Signierung erkennen|Release-Text/.test(step.name || '')) continue;
            if (/Installer bauen/.test(step.name || '')) {
                // electron-builder: exported only when the detection says so, otherwise left unset
                assert.match(step.run, /SIGN_WINDOWS" = true/);
                assert.match(step.run, /CSC_IDENTITY_AUTO_DISCOVERY=false/);
                continue;
            }
            assert.match(String(step.if || ''), /steps\.signing\.outputs\.(macos|windows) == 'true'/, `${f} ${name}: ${step.name}`);
        }
    });

    test('step outputs that are read come from a step with that id in the same job', () => {
        for (const f of files) {
            for (const [name, job] of jobsOf(f)) {
                const ids = new Set((job.steps || []).map(s => s.id).filter(Boolean));
                const text = JSON.stringify(job);
                for (const m of text.matchAll(/steps\.([\w-]+)\.outputs/g)) assert.ok(ids.has(m[1]), `${f} ${name}: unknown step ${m[1]}`);
                for (const m of text.matchAll(/needs\.([\w-]+)\./g)) {
                    const needs = [].concat(job.needs || []);
                    assert.ok(needs.includes(m[1]), `${f} ${name}: needs.${m[1]} without needs`);
                }
            }
        }
    });

    test('calls of the reusable workflows only pass inputs and secrets they declare', () => {
        for (const f of files) {
            for (const [name, job] of jobsOf(f)) {
                if (!job.uses) continue;
                const callee = workflows[path.basename(job.uses)];
                assert.ok(callee, `${f} ${name}: ${job.uses} fehlt`);
                const declared = callee.on.workflow_call;
                for (const input of Object.keys(job.with || {})) assert.ok(input in (declared.inputs || {}), `${f} ${name}: input ${input}`);
                if (job.secrets && job.secrets !== 'inherit') {
                    for (const secret of Object.keys(job.secrets)) assert.ok(secret in (declared.secrets || {}), `${f} ${name}: secret ${secret}`);
                }
            }
        }
    });

    test('reusable workflows declare every secret they read', () => {
        for (const f of ['build.yml', 'mobile.yml']) {
            const declared = Object.keys(workflows[f].on.workflow_call.secrets || {});
            const used = [...new Set([...source(f).matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]))];
            assert.deepEqual(used.filter(s => !declared.includes(s)), [], f);
        }
    });

    test('the release publishes the ZIP, the binaries, the installers, the apps and SHA256SUMS.txt as latest', () => {
        const publish = workflows['release.yml'].jobs.publish;
        const release = publish.steps.find(s => String(s.uses).startsWith('softprops/action-gh-release@'));
        assert.equal(release.with.files, 'dist/release/*');
        assert.equal(release.with.make_latest, 'true');
        assert.equal(release.with.prerelease, false);
        assert.equal(release.with.tag_name, '${{ needs.version.outputs.tag }}');
        assert.ok(publish.steps.some(s => /checksums\.js dist\/release/.test(s.run || '')));
        const download = publish.steps.find(s => String(s.uses).startsWith('actions/download-artifact@'));
        assert.equal(download.with.pattern, '{pterodactyl-zip,server-*,desktop-*,mobile-*}');
        assert.deepEqual(publish.needs, ['version', 'tag', 'build', 'mobile', 'docker']);
    });

    test('the Docker job pushes only the immutable version tags, after every build incl. the apps, with a keyless signature that may fail', () => {
        const docker = workflows['release.yml'].jobs.docker;
        assert.deepEqual([...docker.needs].sort(), ['build', 'mobile', 'tag', 'version']);
        const meta = docker.steps.find(s => String(s.uses).startsWith('docker/metadata-action@'));
        assert.match(meta.with.tags, /pattern=\{\{version\}\}/);
        assert.match(meta.with.tags, /pattern=v\{\{version\}\}/);
        assert.doesNotMatch(meta.with.tags, /latest|\{\{major\}\}\.\{\{minor\}\}/, 'moving tags belong to publish');
        assert.match(meta.with.flavor, /latest=false/, 'metadata-action would add latest for semver tags on its own');
        const sign = docker.steps.find(s => /cosign sign/.test(s.run || ''));
        assert.equal(sign['continue-on-error'], true);
        const push = docker.steps.find(s => String(s.uses).startsWith('docker/build-push-action@'));
        assert.equal(push.with.platforms, 'linux/amd64,linux/arm64');
        assert.equal(push.with.push, true);
        assert.equal(push.id, 'push');
        assert.equal(docker.outputs.digest, '${{ steps.push.outputs.digest }}');
        const build = workflows['build.yml'].jobs.docker.steps.find(s => String(s.uses).startsWith('docker/build-push-action@'));
        assert.equal(build.with.push, false);
    });

    test('X.Y and latest move to the pushed digest only after the GitHub release exists', () => {
        const publish = workflows['release.yml'].jobs.publish;
        const index = (pred) => publish.steps.findIndex(pred);
        const release = index(s => String(s.uses).startsWith('softprops/action-gh-release@'));
        const retag = index(s => /docker buildx imagetools create/.test(s.run || ''));
        assert.ok(release >= 0 && retag > release, 'retag after the release step');
        const step = publish.steps[retag];
        assert.match(step.run, /--tag "\$IMAGE:latest"/);
        assert.match(step.run, /--tag "\$IMAGE:\$minor"/);
        assert.match(step.run, /"\$IMAGE@\$DIGEST"/);
        assert.equal(step.env.DIGEST, '${{ needs.docker.outputs.digest }}');
        assert.ok(!('continue-on-error' in step));
        assert.equal(permissionsOf('release.yml', publish).packages, 'write');
        for (const [name, job] of jobsOf('release.yml')) {
            if (name === 'publish') continue;
            assert.doesNotMatch(JSON.stringify(job), /:latest|imagetools create/, `${name} must not move latest`);
        }
    });

    test('build.yml produces the server binaries for every platform with a smoke test', () => {
        const job = workflows['build.yml'].jobs['server-binaries'];
        const targets = job.strategy.matrix.include.map(m => m.targets).join(',').split(',').sort();
        assert.deepEqual(targets, ['linux-arm64', 'linux-x64', 'macos-universal', 'windows-x64']);
        assert.ok(job.steps.some(s => /smoke\.js/.test(s.run || '')));
        assert.ok(workflows['build.yml'].jobs['server-packages'].steps.some(s => /nfpm/.test(s.run || '')));
        const deb = workflows['build.yml'].jobs['server-packages'].steps.find(s => /apt-get install/.test(s.run || ''));
        assert.match(deb.run, /stat -c %a \/var\/lib\/manga-shelf\)" = 750/);
        assert.match(deb.run, /manga\.db ist für alle lesbar/);
        const probe = job.steps.find(s => /service-probe\.js/.test(s.run || ''));
        assert.ok(probe, 'install-service is exercised on the runners');
        assert.equal(probe.if, "runner.os != 'macOS'");
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'scripts', 'server-bin', 'service-probe.js')));
    });

    test('a signed Android build is checked with apksigner: release APK and AAB present, never the debug key', () => {
        const steps = workflows['mobile.yml'].jobs.android.steps;
        const build = steps.findIndex(s => /npm run build:android/.test(s.run || ''));
        const verify = steps.findIndex(s => /apksigner" verify --print-certs/.test(s.run || ''));
        const upload = steps.findIndex(s => String(s.uses).startsWith('actions/upload-artifact@'));
        assert.ok(build >= 0 && verify > build && upload > verify);
        const step = steps[verify];
        assert.equal(step.if, "steps.project.outputs.present == 'true' && env.MODE == 'build'");
        assert.match(step.run, /CN=Android Debug/);
        assert.match(step.run, /test -f build\/out\/\*-android\.aab/);
        assert.equal(step.env.ANDROID_KEYSTORE_BASE64, '${{ secrets.ANDROID_KEYSTORE_BASE64 }}');
    });
});
