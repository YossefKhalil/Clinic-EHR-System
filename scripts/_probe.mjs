import fs from 'node:fs';
const p = 'C:/Users/AppData/Local/Temp/opencode/clinic-ai/comments.json';
console.log('exists', fs.existsSync(p));
try { console.log('len', fs.readFileSync(p, 'utf8').length); } catch (e) { console.log('ERR', e.code); }
