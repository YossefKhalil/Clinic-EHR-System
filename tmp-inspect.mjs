import { readFileSync } from 'node:fs';

const l = readFileSync('index.html', 'utf8').split('\n');
for (let k = 538; k < 552; k += 1) console.log(k + 1, JSON.stringify(l[k]));
