// Validate the new minimal provider output
const fs = require('fs');
const src = fs.readFileSync('extensions/vscode/out/webview/provider.js', 'utf8');

// Find the template literal... wait, the new version uses string concatenation, not template literal
// Look for the pattern: return '\x3C!DOCTYPE html>
const retIdx = src.indexOf("return '\\x3C!DOCTYPE html>");
if (retIdx === -1) {
  console.log('Could not find return statement with HTML');
  // Show what's around the getHtmlContent method
  const funcIdx = src.indexOf('getHtmlContent');
  console.log('getHtmlContent at:', funcIdx);
  console.log('Context:', src.substring(funcIdx, funcIdx + 200));
  process.exit(1);
}

// The string is concatenated with +, ending at the last ' before the closing }
// Find the end: look for '</html>'
const endMarker = "</html>'";
const endIdx = src.indexOf(endMarker, retIdx);
if (endIdx === -1) {
  console.log('Could not find end of HTML string');
  process.exit(1);
}

const htmlStr = src.substring(retIdx + 7, endIdx + endMarker.length - 1); // Extract between quotes

// Now we need to evaluate this string expression... It's complex with concatenation.
// Instead, let's create a mock for vscode and nonce, then eval the getHtmlContent function

console.log('HTML string segment length:', htmlStr.length);
console.log('First 200 chars:', htmlStr.substring(0, 200));
console.log('Last 200 chars:', htmlStr.substring(htmlStr.length - 200));

// For a full validation, let's extract the script tag content from the compiled file
// by searching for the JS code pattern
const scriptMatch = src.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.log('Could not find script tag in source');
  process.exit(1);
}

const scriptContent = scriptMatch[1];
console.log('\nScript content length:', scriptContent.length);
console.log('First 150 chars of script:', scriptContent.substring(0, 150));

// Try to parse the JS
try {
  new Function(scriptContent);
  console.log('SUCCESS: JavaScript syntax is valid!');
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
  const lines = scriptContent.split('\n');
  console.log('\nAll script lines:');
  for (let j = 0; j < lines.length; j++) {
    console.log((j + 1) + ': ' + lines[j].substring(0, 150));
  }
}

// Check for the regex patterns
const regexLines = scriptContent.match(/replace\([^)]+\)/g);
if (regexLines) {
  console.log('\nRegex patterns found:');
  regexLines.forEach(r => console.log('  ' + r.substring(0, 80)));
}
