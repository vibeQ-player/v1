import { mkdir, cp, copyFile } from 'node:fs/promises';
const target = '.deploy/api';
await mkdir(target, { recursive: true });
for (const name of ['package.json', 'package-lock.json', 'host.json', 'functions.js']) await copyFile(`api/${name}`, `${target}/${name}`);
await cp('server', `${target}/server`, { recursive: true });
await copyFile('LICENSE', `${target}/LICENSE`);
console.log(`Functions package prepared in ${target}. Install its production dependencies before local execution.`);
