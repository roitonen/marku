import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const paths = [
  'package.json',
  'package-lock.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
];

function updateJson(text, version, path) {
  const data = JSON.parse(text);
  if (typeof data.version !== 'string') {
    throw new Error(`Missing application version in ${path}`);
  }
  data.version = version;

  if (path === 'package-lock.json') {
    if (typeof data.packages?.['']?.version !== 'string') {
      throw new Error('Missing root package version in package-lock.json');
    }
    data.packages[''].version = version;
  }

  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  return `${JSON.stringify(data, null, 2)}\n`.replaceAll('\n', newline);
}

function updateToml(text, version, path) {
  const lines = text.split('\n');
  const packageHeader = path.endsWith('Cargo.lock') ? '[[package]]' : '[package]';
  let section = '';
  let foundMarku = false;
  let matches = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const content = line.split('#')[0].trim();

    if (content.startsWith('[')) {
      section = content;
      foundMarku = false;
      continue;
    }
    if (section !== packageHeader) continue;

    const equals = content.indexOf('=');
    if (equals === -1) continue;
    const key = content.slice(0, equals).trim();
    const value = content.slice(equals + 1).trim();

    if (key === 'name') foundMarku = value === '"marku"';
    if (!foundMarku || key !== 'version') continue;
    if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
      throw new Error(`Expected a quoted marku package version in ${path}`);
    }

    const valueStart = line.indexOf('"');
    lines[index] = line.slice(0, valueStart) + `"${version}"` + line.slice(valueStart + value.length);
    matches += 1;
  }

  if (matches !== 1) {
    throw new Error(`Expected exactly one marku package version in ${path}`);
  }
  return lines.join('\n');
}

async function main() {
  const [version, ...extra] = process.argv.slice(2);
  const numeric = '(?:0|[1-9][0-9]*)';
  const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const semver = new RegExp(
    `^${numeric}\\.${numeric}\\.${numeric}` +
    `(?:-${identifier}(?:\\.${identifier})*)?` +
    '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
  );
  if (!version || extra.length || version.trim() !== version || !semver.test(version)) {
    throw new Error('Usage: npm run version:set -- <version> (for example, 0.2.3 or 0.3.0-beta.1)');
  }

  // Read and validate every file before writing any changes.
  const updates = await Promise.all(paths.map(async (path) => {
    const url = new URL(path, root);
    const original = await readFile(url, 'utf8');
    const updated = path.endsWith('.json')
      ? updateJson(original, version, path)
      : updateToml(original, version, path);
    return { url, original, updated };
  }));

  for (const { url, original, updated } of updates) {
    if (original !== updated) await writeFile(url, updated);
  }
  console.log(`Application version set to ${version} in all five files.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
