import * as fs from 'fs';
import * as path from 'path';

const filePath = path.join(__dirname, 'utils', 'reportTemplates.ts');

// Read the file
let content = fs.readFileSync(filePath, 'utf8');

// Fix the array destructuring syntax
content = content.replace(
  /\.sort\(\(\[,a\], \[,b\]\) => b - a\)/g,
  '.sort((a, b) => b[1] - a[1])'
);

// Write the fixed content back
fs.writeFileSync(filePath, content, 'utf8');

console.log('Fixed array destructuring syntax in reportTemplates.ts'); 