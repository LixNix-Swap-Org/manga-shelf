const errors = require('../core/errors');

/** For handlers that answer an error themselves instead of throwing (streams already set up, cleanup in finally). */
const sendError = (res, status, message, code, extra) => res.status(status).json(errors.errorBody(res.req, status, message, code, extra));

module.exports = { ...errors, sendError };
