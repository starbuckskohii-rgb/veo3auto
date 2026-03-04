const fs = require('fs');
const lines = fs.readFileSync('worker.js', 'utf8').split('\n');
let o = 0;
for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    o += (l.match(/{/g) || []).length - (l.match(/}/g) || []).length;
    if (o < 0) console.log(`NEGATIVE BRACKET at line ${i + 1}: ${l}`);
    if (i > 490 && i < 560) console.log(`${i + 1}(${o})\t${l.trim()}`);
}
