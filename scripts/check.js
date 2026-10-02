import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
for (const dir of ['server', 'api', 'scripts']) {
  for (const file of readdirSync(dir).filter(file => file.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
    if (result.status) process.exit(result.status);
  }
}
