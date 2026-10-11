// Packages this extension into a VSIX and installs it into VS Code.
// Usage: npm run install:local
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
const isWin = process.platform === 'win32';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: isWin });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function findCodeCli() {
  const candidates = ['code'];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code');
  } else if (isWin) {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'));
  }
  for (const candidate of candidates) {
    if (candidate === 'code') {
      const probe = spawnSync('code', ['--version'], { stdio: 'ignore', shell: isWin });
      if (probe.status === 0) return 'code';
    } else if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) {
  console.error(`Node.js 18 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}

const code = findCodeCli();
if (!code) {
  console.error('Không tìm thấy lệnh "code". Trong VS Code: Command Palette → "Shell Command: Install \'code\' command in PATH", rồi chạy lại.');
  process.exit(1);
}

console.log('1/2 Đóng gói extension…');
run(isWin ? 'npx.cmd' : 'npx', ['--yes', '@vscode/vsce', 'package', '--no-dependencies', '--allow-missing-repository', '--skip-license', '-o', vsix]);

console.log('2/2 Cài vào VS Code…');
run(code, ['--install-extension', vsix, '--force']);

console.log(`\nXong. Trong VS Code chạy "Developer: Reload Window" để áp dụng.`);
