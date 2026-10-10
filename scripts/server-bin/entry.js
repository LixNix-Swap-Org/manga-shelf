const updatePrelude = require('../../services/update/prelude');
const argv = process.argv.slice(2);
const preludeOptions = require('./cli').preludeOptions(argv);
if (preludeOptions) updatePrelude.run({ ...preludeOptions, version: require('../../package.json').version });
require('./main').run(argv);
