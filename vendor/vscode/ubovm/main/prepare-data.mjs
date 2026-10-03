import { prepareDataPaths } from './data-paths.mjs';

// Shared preparation for the BAT launcher and direct Electron bootstrap.
const args = process.argv.slice(2);
let profile = 'desktop', legacyRoot;
try {
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (!['--profile', '--legacy-root'].includes(name) || !args[index + 1]) throw new Error('Usage: prepare-data.mjs --profile desktop|source|smoke --legacy-root <project>');
    const value = args[++index];
    if (name === '--profile') profile = value; else legacyRoot = value;
  }
  process.stdout.write(JSON.stringify(prepareDataPaths({ profile, legacyRoot })) + '\n');
} catch (error) {
  process.stderr.write('[UBOVM] ' + error.message + '\n');
  process.exitCode = 1;
}
