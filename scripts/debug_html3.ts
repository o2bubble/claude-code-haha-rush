// Check generated HTML for issues
const fs = require('fs');
const src = fs.readFileSync('extensions/vscode/out/webview/provider.js', 'utf8');

// Find the template literal
const startMarker = 'return `<!DOCTYPE html>';
const retIdx = src.indexOf(startMarker);
const openBacktick = retIdx + 'return '.length; // position of the opening `
let i = openBacktick + 1; // start after the opening `
while (i < src.length) {
  if (src[i] === '`' && src[i - 1] !== '\\') break;
  i++;
}
const html = src.slice(openBacktick + 1, i); // content between backticks

console.log('HTML length:', html.length);

// Check for </script> — this would break HTML parsing
const scriptCloseRegex = /<\/script/i;
const match = html.match(scriptCloseRegex);
if (match) {
  console.log('FOUND </script> at index:', match.index);
  console.log('Context:', html.substring(match.index - 20, match.index + 30));
} else {
  console.log('No </script> found in HTML (good)');
}

// Show lines 260-265 with full detail
const lines = html.split('\n');
console.log('\n--- Lines 258-268 ---');
for (let j = 257; j < Math.min(lines.length, 268); j++) {
  const line = lines[j];
  console.log(`Line ${j + 1}: ${JSON.stringify(line.substring(0, 130))}`);
  // Check for unusual control chars
  for (let k = 0; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c < 32 && c !== 9 && c !== 13) {
      console.log(`  WARNING: control char \\x${c.toString(16)} at col ${k}`);
    }
  }
}

// Check the script tag boundaries
const scriptStartIdx = html.indexOf('<script');
const scriptEndIdx = html.indexOf('</script>');
console.log('\n<script> starts at index:', scriptStartIdx);
console.log('</script> at index:', scriptEndIdx);

// Show the script tag opening
console.log('\nScript tag open:');
console.log(html.substring(scriptStartIdx, scriptStartIdx + 100));

// Show lines around the regex patterns in the generated HTML
const regexLines = [];
for (let j = 0; j < lines.length; j++) {
  if (lines[j].includes('replace')) {
    console.log(`\nRegex line ${j + 1}: ${JSON.stringify(lines[j].substring(0, 150))}`);
  }
}
