const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = ['.git', 'node_modules', '.venv-whisper', '.whisper-models', '.github', 'assests'];
const ALLOWED_EXTS = ['.js', '.html', '.md', '.json', '.sh', '.nsh', '.css', '.txt', '.xml', '.webmanifest'];

const SEARCH_REPLACE = [
    { search: /AI Copilot/g, replace: 'AI Copilot' },
    { search: /ai-copilot/g, replace: 'ai-copilot' },
    { search: /AI_COPILOT/g, replace: 'AI_COPILOT' },
    { search: /AI Copilot/g, replace: 'AI Copilot' }
];

function processDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
            if (!IGNORE_DIRS.includes(file)) {
                processDirectory(fullPath);
            }
        } else if (stat.isFile()) {
            const ext = path.extname(file);
            // Allow exact files without extension like '.env.example' or 'LICENSE' etc.
            if (ALLOWED_EXTS.includes(ext) || file === 'LICENSE' || file === 'env.example' || file === '.env.example') {
                processFile(fullPath);
            }
        }
    }
}

function processFile(filePath) {
    try {
        let content = fs.readFileSync(filePath, 'utf8');
        let originalContent = content;
        
        for (const { search, replace } of SEARCH_REPLACE) {
            content = content.replace(search, replace);
        }
        
        if (content !== originalContent) {
            fs.writeFileSync(filePath, content, 'utf8');
            console.log(`Updated: ${filePath}`);
        }
    } catch (err) {
        console.error(`Failed to process ${filePath}:`, err);
    }
}

// Start processing from current directory
processDirectory(__dirname);
console.log('Renaming complete.');
