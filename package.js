const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const outputDir = path.join(__dirname, 'dist_pack');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

const outputPath = path.join(outputDir, 'pterodactyl-manga-shelf.zip');
const output = fs.createWriteStream(outputPath);
const archive = archiver('zip', {
  zlib: { level: 9 } // Sets the compression level.
});

output.on('close', function() {
  console.log('Packaging complete!');
  console.log(`Created artifact at: ${outputPath} (${archive.pointer()} total bytes)`);
  // Also copy to root for easy user access
  fs.copyFileSync(outputPath, path.join(__dirname, 'pterodactyl-manga-shelf.zip'));
  console.log('Also updated root pterodactyl-manga-shelf.zip');
  console.log('You can now upload this ZIP to your Pterodactyl server.');
});

archive.on('error', function(err) {
  throw err;
});

archive.pipe(output);

// Add backend files
archive.file('package.json', { name: 'package.json' });
archive.file('index.js', { name: 'index.js' });
archive.file('db.js', { name: 'db.js' });
archive.file('mangaPassion.js', { name: 'mangaPassion.js' });

// Add modularized backend folders
archive.directory('routes/', 'routes');
archive.directory('services/', 'services');
archive.directory('middleware/', 'middleware');
archive.directory('utils/', 'utils');

// Add frontend build
archive.directory('frontend/dist/', 'frontend/dist');

// We don't include node_modules or data folder. Pterodactyl should run npm install.
// If we want a standalone zip with all prod dependencies, we would run `npm install --production` here and include node_modules.
// The user requirement says: "vorkompiliertes/produktionsfertiges Backend, alle Production-Dependencies gebündelt oder minimal installierbar."
// We will just assume Pterodactyl Generic Node.js Egg which runs `npm install` on startup.

archive.finalize();
