// Shopping list and release radar logic lives in core/radar.js; this keeps the server's APP_TIMEZONE as default.
const core = require('../core/radar');
const { config } = require('../utils/config');

const zonedToday = (now = new Date(), timeZone = config.appTimeZone) => core.zonedToday(now, timeZone);

module.exports = { ...core, zonedToday };
