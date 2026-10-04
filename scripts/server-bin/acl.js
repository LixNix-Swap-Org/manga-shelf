// File permissions of the server binary. Windows: security descriptors read through PowerShell as SIDs only (names
// are localised; anything else refuses), checked against allow-lists. Everywhere: a .env other users may change is
// refused before dotenv sees it (it can set JWT_SECRET, FRONTEND_DIR, MANGA_SHELF_CACHE_DIR …).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SID = {
    SYSTEM: 'S-1-5-18',
    LOCAL_SERVICE: 'S-1-5-19',
    NETWORK_SERVICE: 'S-1-5-20',
    ADMINISTRATORS: 'S-1-5-32-544',
    CREATOR_OWNER: 'S-1-3-0'
};
const SID_PATTERN = /^S-1-\d+(-\d+)+$/i;
// WriteData/AddFile, AppendData/AddSubdirectory, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE
const WRITE_RIGHTS = 0x2 | 0x4 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
const REPARSE_POINT = 0x400;

/** Absolute path of a Windows tool in System32 (never looked up in the working directory or PATH). */
function systemTool(name, env = process.env) {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    return name.toLowerCase() === 'powershell.exe'
        ? path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : path.win32.join(root, 'System32', name);
}

// GetAccessRules/GetOwner with SecurityIdentifier never translate names; under Constrained Language Mode they throw
const SECURITY_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    '$p = $env:MANGA_SHELF_ACL_PATH',
    '$sid = [System.Security.Principal.SecurityIdentifier]',
    '$item = Get-Item -LiteralPath $p -Force',
    '$acl = Get-Acl -LiteralPath $p',
    '$aces = @($acl.GetAccessRules($true, $true, $sid) | ForEach-Object {',
    '  [pscustomobject]@{ sid = $_.IdentityReference.Value; rights = [int]$_.FileSystemRights; type = [string]$_.AccessControlType; inheritOnly = (([int]$_.PropagationFlags) -band 2) -ne 0 }',
    '})',
    `$out = [pscustomobject]@{ owner = $acl.GetOwner($sid).Value; reparse = (([int]$item.Attributes) -band ${REPARSE_POINT}) -ne 0; aces = $aces }`,
    'ConvertTo-Json -InputObject $out -Compress -Depth 4'
].join('\n');

const RESOLVE_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    '$a = $env:MANGA_SHELF_ACCOUNT',
    "if ($a -match '^S-1-\\d+(-\\d+)+$') {",
    '  $s = New-Object System.Security.Principal.SecurityIdentifier($a)',
    '  [void]$s.Translate([System.Security.Principal.NTAccount])',
    '} else {',
    '  $s = (New-Object System.Security.Principal.NTAccount($a)).Translate([System.Security.Principal.SecurityIdentifier])',
    '}',
    '$s.Value'
].join('\n');

// a fresh protected DACL on the root (Administrators, SYSTEM, the service account); below it every explicit entry is
// dropped so everything inherits from the root; any reparse point stops it
const PROTECT_SCRIPT = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    '  $root = $env:MANGA_SHELF_ROOT',
    '  $sidType = [System.Security.Principal.SecurityIdentifier]',
    '  function Assert-NoLink($item) {',
    `    if ((([int]$item.Attributes) -band ${REPARSE_POINT}) -ne 0) { throw "Verknuepfung (Reparse-Punkt): $($item.FullName)" }`,
    '  }',
    '  $top = Get-Item -LiteralPath $root -Force',
    '  Assert-NoLink $top',
    '  $sec = New-Object System.Security.AccessControl.DirectorySecurity',
    '  $sec.SetAccessRuleProtection($true, $false)',
    `  foreach ($sid in (@('${SID.ADMINISTRATORS}', '${SID.SYSTEM}', $env:MANGA_SHELF_SID) | Select-Object -Unique)) {`,
    '    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier($sid)), [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.InheritanceFlags]\'ContainerInherit, ObjectInherit\', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)',
    '    $sec.AddAccessRule($rule)',
    '  }',
    '  $top.SetAccessControl($sec)',
    '  function Reset-Children($dir) {',
    '    foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force)) {',
    '      Assert-NoLink $item',
    "      $acl = $item.GetAccessControl('Access')",
    '      foreach ($rule in @($acl.GetAccessRules($true, $false, $sidType))) { [void]$acl.RemoveAccessRuleSpecific($rule) }',
    '      $acl.SetAccessRuleProtection($false, $false)',
    '      $item.SetAccessControl($acl)',
    '      if ($item.PSIsContainer) { Reset-Children $item.FullName }',
    '    }',
    '  }',
    '  Reset-Children $root',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
].join('\n');

const encodedArgs = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const aclCommandArgs = () => encodedArgs(SECURITY_SCRIPT);
const protectArgs = () => encodedArgs(PROTECT_SCRIPT);

function checkedSid(value) {
    const text = String(value ?? '');
    if (!SID_PATTERN.test(text)) throw new Error(`keine SID in der ACL-Ausgabe ("${text.slice(0, 40)}")`);
    return text.toUpperCase();
}

/** { owner, reparse, aces: [{ sid, rights (uint32), allow, inheritOnly }] } from the script's JSON; throws on any non-SID. */
function parseSecurity(text) {
    const data = JSON.parse(String(text).trim());
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('unerwartete ACL-Ausgabe');
    return {
        owner: checkedSid(data.owner),
        reparse: data.reparse === true,
        aces: [].concat(data.aces ?? []).filter(Boolean).map((e) => ({
            sid: checkedSid(e.sid),
            rights: Number(e.rights) >>> 0,
            allow: String(e.type) === 'Allow',
            inheritOnly: e.inheritOnly === true
        }))
    };
}

function defaultCapture(cmd, args, { env } = {}) {
    return execFileSync(cmd, args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function readWindowsSecurity(file, { capture = defaultCapture, env = process.env } = {}) {
    return parseSecurity(capture(systemTool('powershell.exe', env), aclCommandArgs(), { env: { ...env, MANGA_SHELF_ACL_PATH: file } }));
}

/** SID of a Windows account name or SID (NTAccount.Translate); throws when it does not resolve. */
function resolveAccountSid(account, { capture = defaultCapture, env = process.env } = {}) {
    const sid = String(capture(systemTool('powershell.exe', env), encodedArgs(RESOLVE_SCRIPT), { env: { ...env, MANGA_SHELF_ACCOUNT: account } })).trim();
    if (!SID_PATTERN.test(sid)) throw new Error(`keine SID für ${account}`);
    return sid.toUpperCase();
}

/**
 * Entries that break the allow-list: an Allow entry for any SID not in `allowed` (CREATOR OWNER only inherit-only),
 * with `write` only those that can change the object, and Deny entries for the SIDs in `denyFor`.
 */
function foreignAces(security, allowed, { write = false, denyFor = [] } = {}) {
    const ok = new Set(allowed.filter(Boolean).map((s) => s.toUpperCase()));
    const denied = new Set(denyFor.filter(Boolean).map((s) => s.toUpperCase()));
    return security.aces.filter((a) => {
        if (!a.allow) return denied.has(a.sid);
        if (ok.has(a.sid) || (a.sid === SID.CREATOR_OWNER && a.inheritOnly)) return false;
        return !write || (a.rights & WRITE_RIGHTS) !== 0;
    });
}

/** German reason why a path of the service's data folder is not private to the service account, or null. */
function serviceAclProblem(security, serviceSid) {
    const allowed = [SID.ADMINISTRATORS, SID.SYSTEM, serviceSid];
    if (security.reparse) return 'ist eine Verknüpfung (Reparse-Punkt)';
    if (!allowed.includes(security.owner)) return `gehört ${security.owner}`;
    const foreign = foreignAces(security, allowed, { denyFor: [serviceSid] });
    const denied = foreign.filter((a) => !a.allow);
    if (denied.length) return `das Dienstkonto ${serviceSid} wird ausgesperrt (Verweigern-Eintrag)`;
    if (foreign.length) return `ist noch für andere Konten zugänglich (${[...new Set(foreign.map((a) => a.sid))].join(', ')})`;
    if (!security.aces.some((a) => a.allow && !a.inheritOnly && a.sid === serviceSid)) return `das Dienstkonto ${serviceSid} hat keinen Zugriff`;
    return null;
}

/** SID of this process from `whoami /user /fo csv /nh` ("nt authority\\local service","S-1-5-19"). */
function parseWhoami(text) {
    const match = /"(S-1-[\d-]+)"\s*$/m.exec(String(text).trim());
    return match ? match[1] : null;
}

function currentSid({ capture = defaultCapture, env = process.env } = {}) {
    const sid = parseWhoami(capture(systemTool('whoami.exe', env), ['/user', '/fo', 'csv', '/nh']));
    if (!sid) throw new Error('eigenes Konto nicht ermittelt');
    return sid.toUpperCase();
}

const lstatOrNull = (file) => fs.lstatSync(file, { throwIfNoEntry: false }) || null;
const sameFile = (a, b) => Boolean(a && b) && a.dev === b.dev && a.ino === b.ino;

/** Unix rules for the opened .env (`st`) in its folder (`dir`); German reason or null. */
function unixEnvProblem({ file, dataDir, st, dir, uid }) {
    const stop = 'der Server startet so nicht';
    if (uid !== null && st.uid !== uid && st.uid !== 0) return `${file} gehört einem anderen Benutzer (uid ${st.uid}); ${stop}. Prüfen und löschen oder mit chown übernehmen.`;
    if (st.mode & 0o022) return `${file} dürfen auch andere Benutzer ändern; ${stop}. Rechte einschränken (chmod 600 "${file}") oder die Datei löschen.`;
    const dirOwned = uid === null || dir.uid === uid || dir.uid === 0;
    if ((dir.mode & 0o022) && !dirOwned) return `Den Datenordner ${dataDir} dürfen auch andere Benutzer ändern; mit ${file} ${stop}. Rechte einschränken (chmod 700 "${dataDir}") oder die .env löschen.`;
    if ((dir.mode & 0o1000) && uid !== null && st.uid !== uid) return `${file} liegt in einem Ordner mit Sticky-Bit und gehört nicht diesem Benutzer (uid ${st.uid}); ${stop}.`;
    return null;
}

/**
 * <dataDir>/.env read once through a checked descriptor: { content: Buffer|null, problem: German text|null }.
 * Fails closed: a link, another owner, write access for others or a check that cannot run is refused. No file: both null.
 */
function readEnvFile(dataDir, { platform = process.platform, uid = process.getuid ? process.getuid() : null, readSecurity = readWindowsSecurity, sid = null, capture = defaultCapture } = {}) {
    const file = path.join(dataDir, '.env');
    const win = platform === 'win32';
    const refuse = (reason, hint = '') => ({ content: null, problem: `${file} ${reason}; der Server startet so nicht.${hint && ` ${hint}`}` });
    let before;
    try {
        before = lstatOrNull(file);
    } catch (err) {
        return refuse(`lässt sich nicht prüfen (${err.code || err.message})`);
    }
    if (!before) return { content: null, problem: null };
    if (before.isSymbolicLink()) return refuse('ist eine Verknüpfung', 'Die Datei direkt in den Datenordner legen oder die Verknüpfung löschen.');
    if (!before.isFile()) return refuse('ist keine Datei');
    let fd;
    try {
        const flags = win ? fs.constants.O_RDONLY : fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
        fd = fs.openSync(file, flags);
    } catch (err) {
        return refuse(`lässt sich nicht öffnen (${err.code || err.message})`);
    }
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || !sameFile(st, before)) return refuse('wurde während der Prüfung ersetzt');
        if (win) {
            let security;
            let own;
            try {
                security = readSecurity(file);
                own = (sid || currentSid({ capture })).toUpperCase();
            } catch (err) {
                return { content: null, problem: `Die Rechte von ${file} lassen sich nicht prüfen (${err.message}); der Server startet so nicht.` };
            }
            const allowed = [own, SID.ADMINISTRATORS, SID.SYSTEM];
            if (security.reparse) return refuse('ist eine Verknüpfung', 'Die Datei direkt in den Datenordner legen oder die Verknüpfung löschen.');
            if (!allowed.includes(security.owner)) return refuse(`gehört einem anderen Konto (${security.owner})`, 'Datei prüfen und löschen oder als dieses Konto neu anlegen.');
            if (foreignAces(security, allowed, { write: true }).length) {
                return { content: null, problem: `${file} dürfen auch andere Benutzer ändern; der Server startet so nicht. Rechte einschränken (icacls "${file}" /inheritance:r /grant:r *${SID.ADMINISTRATORS}:F *${own}:F) oder die Datei löschen.` };
            }
            if (!sameFile(lstatOrNull(file), st)) return refuse('wurde während der Prüfung ersetzt');
        } else {
            const problem = unixEnvProblem({ file, dataDir, st, dir: fs.statSync(dataDir), uid });
            if (problem) return { content: null, problem };
        }
        return { content: fs.readFileSync(fd), problem: null };
    } catch (err) {
        return refuse(`lässt sich nicht prüfen (${err.code || err.message})`);
    } finally {
        fs.closeSync(fd);
    }
}

/** German reason why <dataDir>/.env must not be loaded, or null. */
const envFileProblem = (dataDir, options) => readEnvFile(dataDir, options).problem;

/** icacls arguments: only `sid` and the Administrators keep access to `file`. */
const ownerOnlyArgs = (file, sid) => [file, '/inheritance:r', '/grant:r', `*${sid}:F`, `*${SID.ADMINISTRATORS}:F`, '/Q'];

/**
 * Windows: files (default: secret.key and reset-*.txt in the data folder) that other accounts can open are restricted
 * to this account and the Administrators; already private ones stay. Best effort; returns the files it could not fix.
 */
function restrictWindowsFiles(dataDir, { files = null, sid = null, capture = defaultCapture, readSecurity = (file) => readWindowsSecurity(file, { capture }) } = {}) {
    const names = files || fs.readdirSync(dataDir).filter((n) => n === 'secret.key' || /^reset-.*\.txt$/.test(n));
    let own = sid;
    const failed = [];
    for (const name of names) {
        const file = path.isAbsolute(name) ? name : path.join(dataDir, name);
        if (!fs.existsSync(file)) continue;
        try {
            own = own || currentSid({ capture });
            if (!foreignAces(readSecurity(file), [own, SID.ADMINISTRATORS, SID.SYSTEM]).length) continue;
            capture(systemTool('icacls.exe'), ownerOnlyArgs(file, own));
        } catch (e) {
            failed.push(file);
        }
    }
    return failed;
}

module.exports = {
    SID, SID_PATTERN, WRITE_RIGHTS, SECURITY_SCRIPT, PROTECT_SCRIPT, RESOLVE_SCRIPT, systemTool, aclCommandArgs, protectArgs,
    encodedArgs, parseSecurity, foreignAces, serviceAclProblem, readWindowsSecurity, resolveAccountSid, readEnvFile, unixEnvProblem,
    envFileProblem, parseWhoami, currentSid, ownerOnlyArgs, restrictWindowsFiles, defaultCapture
};
