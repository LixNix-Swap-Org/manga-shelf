// Bundle entry: inside an esbuild bundle `require.main === module` never holds for main.js.
require('./main').run(process.argv.slice(2));
