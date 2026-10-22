// Normalize the line endings of a file to LF.
//
// The repository uses LF. A file that was written through a Windows tool
// comes back with CRLF, and the whole file then shows as changed.
//
// Run: node scripts/normalize-eol.mjs <file>...
import fs from 'node:fs';

for (const file of process.argv.slice(2)) {
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(/\r\n/g, '\n');
    if (before === after) {
        console.log(`${file}: already LF`);
        continue;
    }
    fs.writeFileSync(file, after, 'utf8');
    console.log(`${file}: CRLF -> LF`);
}
