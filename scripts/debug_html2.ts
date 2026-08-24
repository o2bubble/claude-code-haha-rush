// Extract the generated HTML from the compiled provider.js and validate the embedded JS
const fs = require('fs');
const src = fs.readFileSync('extensions/vscode/out/webview/provider.js', 'utf8');

// Find the template literal
const startMarker = 'return `<!DOCTYPE html>';
const start = src.indexOf(startMarker);
if (start === -1) {
  console.log('ERROR: Could not find template literal start');
  process.exit(1);
}

// Find the end of the template literal
let i = start + startMarker.length;
while (i < src.length) {
  if (src[i] === '`' && src[i-1] !== '\\') break;
  i++;
}
const html = src.slice(start + 'return '.length, i);

console.log('HTML length:', html.length);

// Extract the script content
const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.log('ERROR: Could not find script tag');
  process.exit(1);
}

const scriptContent = scriptMatch[1];

console.log('Script length:', scriptContent.length);
console.log('Script lines:', scriptContent.split('\n').length);

// Try to parse with Function constructor to check syntax
try {
  new Function(scriptContent);
  console.log('SUCCESS: JavaScript syntax is valid!');
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
  // Extract line/column from error message (format varies by engine)
  const errStr = e.toString();
  console.log('Full error:', errStr);
  // Show script lines with focus on middle section
  const lines = scriptContent.split('\n');
  console.log(`\nFirst 40 lines of script:`);
  for (let j = 0; j < Math.min(lines.length, 40); j++) {
    console.log(`${j+1}: ${lines[j]?.substring(0, 150)}`);
  }
  console.log(`\nLines 240-270 of script:`);
  for (let j = 239; j < Math.min(lines.length, 270); j++) {
    console.log(`${j+1}: ${lines[j]?.substring(0, 150)}`);
  }
}
