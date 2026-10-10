const { updateError } = require('./errors');

const PHASES = new Set(['preparing', 'ready', 'applying', 'restarting']);
let phase = null;
let maintenance = false;

const currentPhase = () => phase;

/** True while an update is applied or the server restarts for it (restore, snapshots, deletes refuse then). */
const isUpdateRunning = () => phase === 'applying' || phase === 'restarting';

/** True while anything of an update holds the lock, including a download. */
const isBusy = () => phase !== null;

/** Throws 409 UPDATE_RUNNING while an update is applied. */
function assertNoUpdate() {
    if (isUpdateRunning()) throw updateError('UPDATE_RUNNING');
}

/** Takes the lock for `next`; refuses UPDATE_RUNNING while applying and UPDATE_BUSY while another download runs. */
function begin(next) {
    if (!PHASES.has(next)) throw new Error('unknown update phase');
    if (isUpdateRunning()) throw updateError('UPDATE_RUNNING');
    if (next === 'preparing' && phase === 'preparing') throw updateError('UPDATE_BUSY');
    if (next === 'applying' && phase !== 'ready') throw updateError('UPDATE_BUSY');
    phase = next;
}

function setPhase(next) {
    if (!PHASES.has(next)) throw new Error('unknown update phase');
    phase = next;
}

function release() {
    phase = null;
    maintenance = false;
}

function setMaintenance(on) {
    maintenance = Boolean(on);
}

const isMaintenance = () => maintenance;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isUpdateEndpoint = (req) => /^\/api\/system\/update(\/|$|\?)/.test(req.originalUrl || req.url || '');

/** Express middleware: during maintenance every non-GET request except the update endpoints gets 503 MAINTENANCE. */
function maintenanceGuard({ exempt = isUpdateEndpoint } = {}) {
    return (req, res, next) => {
        if (!maintenance || SAFE_METHODS.has(req.method) || exempt(req)) return next();
        res.set('Retry-After', '60');
        return next(updateError('MAINTENANCE'));
    };
}

/** For tests. */
function reset() {
    phase = null;
    maintenance = false;
}

module.exports = { currentPhase, isUpdateRunning, isBusy, assertNoUpdate, begin, setPhase, release, setMaintenance, isMaintenance, maintenanceGuard, reset };
