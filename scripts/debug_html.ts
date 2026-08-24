const fs = require('fs');
const src = fs.readFileSync('extensions/vscode/out/webview/provider.js', 'utf8');
const start = src.indexOf('return `<!DOCTYPE html>') + 8;
let i = start;
while (i < src.length) { if (src[i] === '`' && src[i-1] !== '\\') break; i++; }
const html = src.slice(start, i);
const lines = html.split('\n');
console.log('Total lines:', lines.length);
// Show lines 225-265
for (let j = 224; j < Math.min(lines.length, 265); j++) {
  console.log((j+1) + ': ' + lines[j].substring(0, 130));
}
