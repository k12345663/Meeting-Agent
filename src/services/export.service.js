const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('../core/logger').createServiceLogger('EXPORT');

class ExportService {
  constructor() {
    this.exportsDir = path.join(app.getPath('documents'), 'OpenCluely_Sessions');
    this.ensureDirectoryExists();
  }

  ensureDirectoryExists() {
    if (!fs.existsSync(this.exportsDir)) {
      try {
        fs.mkdirSync(this.exportsDir, { recursive: true });
        logger.info(`Created exports directory at ${this.exportsDir}`);
      } catch (err) {
        logger.error(`Failed to create exports directory: ${err.message}`);
      }
    }
  }

  async generateSummary(llmService, sessionManager) {
    if (sessionManager.fullTranscript.length === 0) {
      return "No conversation recorded to summarize.";
    }

    const transcriptText = sessionManager.fullTranscript.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n\n');
    try {
      return await llmService.generateSessionSummary(transcriptText, sessionManager.currentMode, sessionManager.referenceContext, sessionManager.meetingPrompt || '');
    } catch (err) {
      logger.error(`Failed to generate summary: ${err.message}`);
      return "Failed to generate summary.";
    }
  }

  async saveSession(llmService, sessionManager) {
    logger.info('Saving session transcript and generating summary...');
    const summary = await this.generateSummary(llmService, sessionManager);
    
    const date = new Date();
    const filename = `Session_${sessionManager.currentMode}_${date.getFullYear()}${(date.getMonth()+1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours()}${date.getMinutes()}.md`;
    const filepath = path.join(this.exportsDir, filename);

    const transcriptText = sessionManager.fullTranscript.map(t => `**${t.role.toUpperCase()}**: ${t.content}`).join('\n\n');

    const meetingPromptText = sessionManager.meetingPrompt ? `**Instructions**: ${sessionManager.meetingPrompt}\n` : '';

    const markdownContent = `# Session Record
**Date**: ${date.toLocaleString()}
**Mode**: ${sessionManager.currentMode}
${meetingPromptText}
${summary}

<details>
<summary><b>Raw Transcript (Internal System Log)</b></summary>

${transcriptText}

</details>
`;

    try {
      fs.writeFileSync(filepath, markdownContent, 'utf8');
      logger.info(`Session saved to ${filepath}`);
      return filepath;
    } catch (err) {
      logger.error(`Failed to save session to file: ${err.message}`);
      return null;
    }
  }
}

module.exports = new ExportService();
