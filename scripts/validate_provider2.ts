// Simulate what the HTML script content would look like at runtime
// by evaluating the string concatenation (with mock values for nonce/cspSource)
const fs = require('fs');
const src = fs.readFileSync('extensions/vscode/out/webview/provider.js', 'utf8');
const lines = src.split('\n');

// Extract lines from getHtmlContent return statement (line 119 to line 677)
// Line 119: return '\x3C!DOCTYPE html>\n' +
// Line 677: '</html>';
// We need to evaluate the string concatenation

// Build the full string by evaluating each line's string part
let html = '';
for (let i = 118; i < 677; i++) {
  const line = lines[i].trim();

  // Each line is either:
  // - A string literal: '...\n' +
  // - Variable interpolation: + webview.cspSource +
  // - Variable: + nonce +

  if (line.startsWith("'") || line.startsWith('"')) {
    // String literal - extract content between quotes
    // Find the opening quote and closing quote (before the + or at end)
    const quote = line[0];
    let end = line.length;
    // Remove trailing ' +' or ';' etc
    while (end > 1 && (line[end-1] === '+' || line[end-1] === ';' || line[end-1] === ' ')) {
      end--;
    }
    // The string ends with the matching quote
    if (line[end-1] === quote && line[end-2] !== '\\') {
      const strContent = line.substring(1, end - 1);
      // Evaluate the string to handle escape sequences
      try {
        html += eval(quote + strContent + quote);
      } catch(e) {
        html += strContent;
      }
    }
  } else if (line.includes('webview.cspSource')) {
    html += 'vscode-webview-resource://mock';
  } else if (line.includes('nonce')) {
    html += 'MOCK_NONCE_1234567890';
  }
}

console.log('HTML length:', html.length);

// Extract the script
const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
if (!scriptMatch) {
  console.log('ERROR: No script tag in generated HTML');
  process.exit(1);
}

const scriptContent = scriptMatch[1];
console.log('Script content length:', scriptContent.length);
console.log('First line:', scriptContent.split('\n')[0]);
console.log('Last line:', scriptContent.split('\n').pop());

// Try to parse
try {
  new Function(scriptContent);
  console.log('SUCCESS: JavaScript is syntactically valid!');
} catch (e) {
  console.log('SYNTAX ERROR:', e.message);
  // Show context around error
  const errStr = e.toString();
  const lineMatch = errStr.match(/line (\d+)/i) || errStr.match(/:(\d+):/);
  if (lineMatch) {
    const errLine = parseInt(lineMatch[1]);
    console.log('Error around line:', errLine);
    const scriptLines = scriptContent.split('\n');
    for (let j = Math.max(0, errLine - 5); j < Math.min(scriptLines.length, errLine + 3); j++) {
      console.log(`${j+1}: ${scriptLines[j]?.substring(0, 150)}`);
    }
  }
}

// Print key functions
const funcMatches = scriptContent.match(/function \w+/g);
console.log('\nFunctions:', funcMatches ? funcMatches.join(', ') : 'none');
