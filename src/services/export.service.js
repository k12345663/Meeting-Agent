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

  /**
   * Build Minutes of Meeting for the session and write them to the exports
   * directory. Returns { filepath, content } so the caller can offer the user
   * a "save as…" copy without regenerating (and re-billing) the document.
   */
  async saveMinutesOfMeeting(llmService, sessionManager, participants = []) {
    if (!sessionManager.fullTranscript || sessionManager.fullTranscript.length === 0) {
      return { filepath: null, content: null, error: 'No conversation was recorded, so there are no minutes to generate.' };
    }

    const transcriptText = sessionManager.fullTranscript
      .map(t => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n\n');

    let content;
    try {
      content = await llmService.generateMinutesOfMeeting(transcriptText, {
        participants,
        meetingPrompt: sessionManager.meetingPrompt || '',
        referenceContext: sessionManager.referenceContext || '',
        startedAt: sessionManager.sessionStartTime || null,
        endedAt: Date.now()
      });
    } catch (err) {
      logger.error(`Failed to generate minutes: ${err.message}`);
      return { filepath: null, content: null, error: `Failed to generate minutes: ${err.message}` };
    }

    const date = new Date();
    const stamp = `${date.getFullYear()}${(date.getMonth() + 1).toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}_${date.getHours().toString().padStart(2, '0')}${date.getMinutes().toString().padStart(2, '0')}`;
    const filepath = path.join(this.exportsDir, `MoM_${stamp}.md`);

    try {
      fs.writeFileSync(filepath, content, 'utf8');
      logger.info(`Minutes of meeting saved to ${filepath}`);
      return { filepath, content, error: null };
    } catch (err) {
      logger.error(`Failed to write minutes: ${err.message}`);
      // The document still generated fine; hand it back so the user can save it elsewhere.
      return { filepath: null, content, error: `Generated the minutes but could not write the file: ${err.message}` };
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
