const fs = require('fs');
const src = fs.readFileSync('extensions/vscode/out/webview/provider.js', 'utf8');

// Find the HTML string start: line 119
const lines = src.split('\n');
console.log('Line 119:', lines[118]?.substring(0, 100));
console.log('Line 120:', lines[119]?.substring(0, 100));

// Count total lines
console.log('Total lines in provider.js:', lines.length);

// Find the end of getHtmlContent (the closing })
// Look for the last line of the return statement: </html>'
const endLine = lines.findIndex((l, i) => i > 118 && l.includes("</html>'"));
console.log('End line:', endLine + 1, ':', lines[endLine]?.substring(0, 100));

// Now extract the "script" lines - find the script tag
let scriptStartLine = -1;
let scriptEndLine = -1;
for (let i = 118; i < lines.length; i++) {
  if (lines[i].includes('<script nonce=')) {
    scriptStartLine = i;
  }
  if (scriptStartLine > 0 && lines[i].includes('</script>')) {
    scriptEndLine = i;
    break;
  }
}

console.log('Script start line:', scriptStartLine + 1);
console.log('Script end line:', scriptEndLine + 1);

// Extract just the JS content between the script tags
// The JS is embedded in string concatenation like: '    var ...\n' +
// So we need to extract what it would look like at runtime

// Let's look at a sample of the JS lines
if (scriptStartLine > 0) {
  console.log('\n--- First 10 lines of JS in source ---');
  for (let i = scriptStartLine + 1; i < Math.min(scriptStartLine + 12, scriptEndLine); i++) {
    console.log(`${i+1}: ${lines[i]?.substring(0, 120)}`);
  }
}

// Count lines in the script section
if (scriptStartLine > 0 && scriptEndLine > 0) {
  console.log(`\nScript section spans lines ${scriptStartLine+1} to ${scriptEndLine+1} (${scriptEndLine - scriptStartLine} lines)`);
}

// Check for any backtick characters in the entire return statement
let hasBacktick = false;
for (let i = 118; i < (endLine || lines.length); i++) {
  if (lines[i].includes('`')) {
    console.log(`\nBacktick found at line ${i+1}: ${lines[i]?.substring(0, 100)}`);
    hasBacktick = true;
  }
}
if (!hasBacktick) {
  console.log('\nNo backticks found in HTML string (good - using string concat)');
}

// Check for \u{ pattern (Unicode code point escapes)
let hasUnicode = false;
for (let i = 118; i < (endLine || lines.length); i++) {
  if (lines[i].includes('\\u{')) {
    console.log(`\nUnicode escape found at line ${i+1}`);
    hasUnicode = true;
  }
}
if (!hasUnicode) {
  console.log('No Unicode code point escapes found (good)');
}

// Check for arrow functions in the JS
let hasArrow = false;
for (let i = scriptStartLine; i < scriptEndLine; i++) {
  if (lines[i].includes('=>')) {
    console.log(`\nArrow function at line ${i+1}`);
    hasArrow = true;
  }
}
if (!hasArrow) {
  console.log('No arrow functions found (good)');
}
