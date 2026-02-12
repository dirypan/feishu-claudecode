import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { IncomingMessage } from '../feishu/event-handler.js';
import { MessageSender } from '../feishu/message-sender.js';
import {
  buildCard,
  buildContinueCard,
  buildHelpCard,
  buildStatusCard,
  buildTextCard,
  type CardState,
} from '../feishu/card-builder.js';
import { ClaudeExecutor } from '../claude/executor.js';
import { StreamProcessor, extractImagePaths } from '../claude/stream-processor.js';
import { SessionManager, type UserSession } from '../claude/session-manager.js';
import { RateLimiter } from './rate-limiter.js';

const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

interface RunningTask {
  abortController: AbortController;
  startTime: number;
  waitingForContinue?: {
    messageId: string;
    lastState: CardState;
    processor: StreamProcessor;
    displayPrompt: string;
    imagePath?: string;
    resolve: (shouldContinue: boolean) => void;
  };
}

export class MessageBridge {
  private executor: ClaudeExecutor;
  private sessionManager: SessionManager;
  private runningTasks = new Map<string, RunningTask>(); // keyed by chatId

  constructor(
    private config: Config,
    private logger: Logger,
    private sender: MessageSender,
  ) {
    this.executor = new ClaudeExecutor(config, logger);
    this.sessionManager = new SessionManager(config.claude.defaultWorkingDirectory, logger);
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    const { userId, chatId } = msg;
    const text = msg.text.trim(); // Always trim input text

    // Check if waiting for continue response
    const task = this.runningTasks.get(chatId);
    if (task?.waitingForContinue) {
      const response = text.toLowerCase();
      if (response === 'yes' || response === 'y') {
        task.waitingForContinue.resolve(true);
        return;
      } else if (response === 'no' || response === 'n') {
        task.waitingForContinue.resolve(false);
        return;
      } else {
        await this.sender.sendCard(
          chatId,
          buildTextCard('⚠️ Invalid Response', 'Please reply with **yes** or **no**.', 'orange'),
        );
        return;
      }
    }

    // Handle file transfer test
    if (text.toLowerCase() === 'file transfer test') {
      const testFilePath = '/home/admin/feishu-claudecode/test-file-transfer.txt';
      const success = await this.sender.sendFileFromPath(chatId, testFilePath);
      if (success) {
        await this.sender.sendText(chatId, '✅ File transfer test successful!');
      } else {
        await this.sender.sendText(chatId, '❌ File transfer test failed.');
      }
      return;
    }

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(msg);
      return;
    }

    // Check working directory
    if (!this.sessionManager.hasWorkingDirectory(chatId)) {
      await this.sender.sendCard(
        chatId,
        buildTextCard(
          '⚠️ Working Directory Not Set',
          'Please set a working directory first:\n`/cd /path/to/your/project`',
          'orange',
        ),
      );
      return;
    }

    // Check if this chat already has a running task
    if (this.runningTasks.has(chatId)) {
      await this.sender.sendCard(
        chatId,
        buildTextCard(
          '⏳ Task In Progress',
          'You have a running task. Use `/stop` to abort it, or wait for it to finish.',
          'orange',
        ),
      );
      return;
    }

    // Execute Claude query
    await this.executeQuery(msg);
  }

  private async handleCommand(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, text } = msg;
    const [cmd, ...args] = text.split(/\s+/);
    const arg = args.join(' ').trim();

    this.logger.info({ userId, chatId, cmd, arg }, 'Processing command');

    switch (cmd.toLowerCase()) {
      case '/help':
        await this.sender.sendCard(chatId, buildHelpCard());
        break;

      case '/cd': {
        if (!arg) {
          await this.sender.sendCard(
            chatId,
            buildTextCard('⚠️ Usage', '`/cd /path/to/project`', 'orange'),
          );
          return;
        }

        // Expand ~ to home directory
        const expanded = arg.startsWith('~') ? arg.replace('~', os.homedir()) : arg;
        const resolvedPath = path.resolve(expanded);

        // Validate directory exists
        try {
          const stat = fs.statSync(resolvedPath);
          if (!stat.isDirectory()) {
            await this.sender.sendCard(
              chatId,
              buildTextCard('❌ Error', `Not a directory: \`${resolvedPath}\``, 'red'),
            );
            return;
          }
        } catch {
          await this.sender.sendCard(
            chatId,
            buildTextCard('❌ Error', `Directory not found: \`${resolvedPath}\``, 'red'),
          );
          return;
        }

        this.sessionManager.setWorkingDirectory(chatId, resolvedPath);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ Working Directory Set', `\`${resolvedPath}\``, 'green'),
        );
        break;
      }

      case '/reset':
        this.sessionManager.resetSession(chatId);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ Session Reset', 'Conversation cleared. Working directory preserved.', 'green'),
        );
        break;

      case '/reset-system-prompt':
        this.sessionManager.setSystemPrompt(chatId, undefined);
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ System Prompt Reset', 'System prompt reset to default from configuration.', 'green'),
        );
        break;

      case '/show-system-prompt': {
        const session = this.sessionManager.getSession(chatId);
        const effectivePrompt = session.systemPrompt !== undefined
          ? session.systemPrompt
          : this.config.claude.systemPrompt;

        if (!effectivePrompt) {
          await this.sender.sendCard(
            chatId,
            buildTextCard('ℹ️ System Prompt', 'No custom system prompt is set. Using Claude\'s default behavior.', 'blue'),
          );
        } else {
          const truncated = effectivePrompt.length > 2000
            ? effectivePrompt.substring(0, 2000) + '...(truncated)'
            : effectivePrompt;
          const source = session.systemPrompt !== undefined ? '**Custom**' : '**Default (from config)**';
          await this.sender.sendCard(
            chatId,
            buildTextCard('ℹ️ Current System Prompt', `${source}\n\n\`\`\`\n${truncated}\n\`\`\``, 'blue'),
          );
        }
        break;
      }

      case '/set-system-prompt': {
        if (!arg) {
          await this.sender.sendCard(
            chatId,
            buildTextCard('⚠️ Usage', '`/set-system-prompt <your custom prompt>`\n\nExample:\n`/set-system-prompt You are a helpful coding assistant. Always explain your reasoning.`', 'orange'),
          );
          return;
        }

        this.sessionManager.setSystemPrompt(chatId, arg);
        const truncated = arg.length > 200 ? arg.substring(0, 200) + '...' : arg;
        await this.sender.sendCard(
          chatId,
          buildTextCard('✅ System Prompt Set', `Custom system prompt applied:\n\`\`\`\n${truncated}\n\`\`\``, 'green'),
        );
        break;
      }

      case '/stop': {
        const task = this.runningTasks.get(chatId);
        if (task) {
          task.abortController.abort();
          this.runningTasks.delete(chatId);
          await this.sender.sendCard(
            chatId,
            buildTextCard('🛑 Stopped', 'Current task has been aborted.', 'orange'),
          );
        } else {
          await this.sender.sendCard(
            chatId,
            buildTextCard('ℹ️ No Running Task', 'There is no task to stop.', 'blue'),
          );
        }
        break;
      }

      case '/status': {
        const session = this.sessionManager.getSession(chatId);
        const isRunning = this.runningTasks.has(chatId);
        await this.sender.sendCard(
          chatId,
          buildStatusCard(userId, session.workingDirectory, session.sessionId, isRunning),
        );
        break;
      }

      case '/send-file': {
        if (!arg) {
          await this.sender.sendCard(
            chatId,
            buildTextCard('⚠️ Usage', '`/send-file /path/to/file`', 'orange'),
          );
          return;
        }

        // Expand ~ to home directory
        const expanded = arg.startsWith('~') ? arg.replace('~', os.homedir()) : arg;
        const resolvedPath = path.resolve(expanded);

        // Validate file exists
        try {
          const stat = fs.statSync(resolvedPath);
          if (!stat.isFile()) {
            await this.sender.sendCard(
              chatId,
              buildTextCard('❌ Error', `Not a file: \`${resolvedPath}\``, 'red'),
            );
            return;
          }

          // Check file size (30MB limit)
          if (stat.size > 30 * 1024 * 1024) {
            await this.sender.sendCard(
              chatId,
              buildTextCard('❌ Error', `File too large: ${(stat.size / 1024 / 1024).toFixed(2)}MB (max 30MB)`, 'red'),
            );
            return;
          }

          // Send the file
          const success = await this.sender.sendFileFromPath(chatId, resolvedPath);
          if (success) {
            await this.sender.sendCard(
              chatId,
              buildTextCard('✅ File Sent', `\`${resolvedPath}\``, 'green'),
            );
          } else {
            await this.sender.sendCard(
              chatId,
              buildTextCard('❌ Error', 'Failed to send file. Check logs for details.', 'red'),
            );
          }
        } catch {
          await this.sender.sendCard(
            chatId,
            buildTextCard('❌ Error', `File not found: \`${resolvedPath}\``, 'red'),
          );
        }
        break;
      }

      default:
        await this.sender.sendCard(
          chatId,
          buildTextCard('❓ Unknown Command', `Unknown command: \`${cmd}\`\nUse \`/help\` for available commands.`, 'orange'),
        );
    }
  }

  private async executeQuery(msg: IncomingMessage): Promise<void> {
    const { userId, chatId, imageKey, messageId: msgId } = msg;
    const text = msg.text.trim();

    // Safety check: never pass commands to Claude
    if (text.startsWith('/')) {
      this.logger.error({ userId, chatId, text }, 'Command leaked through to executeQuery - this is a bug!');
      await this.sender.sendCard(
        chatId,
        buildTextCard('❌ Internal Error', 'Command processing error. Please try again.', 'red'),
      );
      return;
    }

    const session = this.sessionManager.getSession(chatId);
    const cwd = session.workingDirectory!;
    const abortController = new AbortController();

    // Register running task
    this.runningTasks.set(chatId, { abortController, startTime: Date.now() });

    // Setup timeout
    const timeoutId = setTimeout(() => {
      this.logger.warn({ chatId, userId }, 'Task timeout, aborting');
      abortController.abort();
    }, TASK_TIMEOUT_MS);

    // Handle image download if present
    let prompt = text;
    let imagePath: string | undefined;
    if (imageKey) {
      const tmpDir = path.join(os.tmpdir(), 'feishu-claudecode');
      fs.mkdirSync(tmpDir, { recursive: true });
      imagePath = path.join(tmpDir, `${imageKey}.png`);
      const ok = await this.sender.downloadImage(msgId, imageKey, imagePath);
      if (ok) {
        prompt = `${text}\n\n[Image saved at: ${imagePath}]\nPlease use the Read tool to read and analyze this image file.`;
      } else {
        prompt = `${text}\n\n(Note: Failed to download the image from Feishu)`;
      }
    }

    // Send initial "thinking" card
    const displayPrompt = imageKey ? '🖼️ ' + text : text;
    const processor = new StreamProcessor(displayPrompt);
    const initialState: CardState = {
      status: 'thinking',
      userPrompt: displayPrompt,
      responseText: '',
      toolCalls: [],
    };

    const messageId = await this.sender.sendCard(chatId, buildCard(initialState));

    if (!messageId) {
      this.logger.error('Failed to send initial card, aborting');
      this.runningTasks.delete(chatId);
      clearTimeout(timeoutId);
      return;
    }

    const rateLimiter = new RateLimiter(1500);
    let lastState: CardState = initialState;

    try {
      const stream = this.executor.execute({
        prompt,
        cwd,
        sessionId: session.sessionId,
        systemPrompt: session.systemPrompt,
        abortController,
      });

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        const state = processor.processMessage(message);
        lastState = state;

        // Update session ID if discovered
        const newSessionId = processor.getSessionId();
        if (newSessionId && newSessionId !== session.sessionId) {
          this.sessionManager.setSessionId(chatId, newSessionId);
        }

        // Throttled card update for non-final states
        if (state.status !== 'complete' && state.status !== 'error') {
          rateLimiter.schedule(() => {
            this.sender.updateCard(messageId, buildCard(state));
          });
        }
      }

      // Flush any pending update
      await rateLimiter.flush();

      // Check if max turns reached and ask user to continue
      if (lastState.status === 'error' && lastState.errorMessage?.includes('error_max_turns')) {
        const shouldContinue = await this.askToContinue(chatId, messageId, lastState, processor, displayPrompt, imagePath);

        if (shouldContinue) {
          // Continue execution with increased turns
          await this.continueExecution(chatId, messageId, session, abortController, rateLimiter, processor, displayPrompt, imagePath);
          return; // Exit early, cleanup handled in continueExecution
        }
      }

      // Send final card
      await this.sender.updateCard(messageId, buildCard(lastState));

      // Send any images produced by Claude
      await this.sendOutputImages(chatId, processor, lastState);
    } catch (err: any) {
      this.logger.error({ err, chatId, userId }, 'Claude execution error');

      const errorState: CardState = {
        status: 'error',
        userPrompt: displayPrompt,
        responseText: lastState.responseText,
        toolCalls: lastState.toolCalls,
        errorMessage: err.message || 'Unknown error',
      };
      await rateLimiter.flush();
      await this.sender.updateCard(messageId, buildCard(errorState));
    } finally {
      clearTimeout(timeoutId);
      this.runningTasks.delete(chatId);
      // Cleanup temp image
      if (imagePath) {
        try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
      }
    }
  }

  private async sendOutputImages(
    chatId: string,
    processor: StreamProcessor,
    state: CardState,
  ): Promise<void> {
    // Collect image paths from tool calls and response text
    const imagePaths = new Set<string>(processor.getImagePaths());

    // Also scan response text for image paths
    if (state.responseText) {
      for (const p of extractImagePaths(state.responseText)) {
        imagePaths.add(p);
      }
    }

    // Send each image that exists on disk
    for (const imgPath of imagePaths) {
      try {
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) {
          const size = fs.statSync(imgPath).size;
          if (size > 0 && size < 10 * 1024 * 1024) { // Feishu limit: 10MB
            this.logger.info({ imgPath }, 'Sending output image to Feishu');
            await this.sender.sendImageFile(chatId, imgPath);
          }
        }
      } catch (err) {
        this.logger.warn({ err, imgPath }, 'Failed to send output image');
      }
    }
  }

  private async askToContinue(
    chatId: string,
    messageId: string,
    lastState: CardState,
    processor: StreamProcessor,
    displayPrompt: string,
    imagePath?: string,
  ): Promise<boolean> {
    const task = this.runningTasks.get(chatId);
    if (!task) return false;

    // Send continue prompt card
    await this.sender.updateCard(messageId, buildContinueCard(this.config.claude.maxTurns));

    // Wait for user response
    return new Promise<boolean>((resolve) => {
      task.waitingForContinue = {
        messageId,
        lastState,
        processor,
        displayPrompt,
        imagePath,
        resolve,
      };
    });
  }

  private async continueExecution(
    chatId: string,
    messageId: string,
    session: UserSession,
    abortController: AbortController,
    rateLimiter: RateLimiter,
    processor: StreamProcessor,
    displayPrompt: string,
    imagePath?: string,
  ): Promise<void> {
    const task = this.runningTasks.get(chatId);
    if (!task) return;

    // Clear waiting state
    delete task.waitingForContinue;

    // Update card to show continuing
    await this.sender.updateCard(
      messageId,
      buildCard({
        status: 'running',
        userPrompt: displayPrompt,
        responseText: processor.getResponseText(),
        toolCalls: processor.getToolCalls(),
      }),
    );

    let lastState: CardState = {
      status: 'running',
      userPrompt: displayPrompt,
      responseText: processor.getResponseText(),
      toolCalls: processor.getToolCalls(),
    };

    try {
      // Continue with more turns (add 50 more turns)
      const stream = this.executor.execute({
        prompt: 'Please continue with the previous task.',
        cwd: session.workingDirectory!,
        sessionId: session.sessionId,
        systemPrompt: session.systemPrompt,
        abortController,
      });

      for await (const message of stream) {
        if (abortController.signal.aborted) break;

        const state = processor.processMessage(message);
        lastState = state;

        // Update session ID if discovered
        const newSessionId = processor.getSessionId();
        if (newSessionId && newSessionId !== session.sessionId) {
          this.sessionManager.setSessionId(chatId, newSessionId);
        }

        // Throttled card update for non-final states
        if (state.status !== 'complete' && state.status !== 'error') {
          rateLimiter.schedule(() => {
            this.sender.updateCard(messageId, buildCard(state));
          });
        }
      }

      // Flush any pending update
      await rateLimiter.flush();

      // Check again if max turns reached
      if (lastState.status === 'error' && lastState.errorMessage?.includes('error_max_turns')) {
        const shouldContinue = await this.askToContinue(chatId, messageId, lastState, processor, displayPrompt, imagePath);

        if (shouldContinue) {
          // Recursively continue
          await this.continueExecution(chatId, messageId, session, abortController, rateLimiter, processor, displayPrompt, imagePath);
          return;
        }
      }

      // Send final card
      await this.sender.updateCard(messageId, buildCard(lastState));

      // Send any images produced by Claude
      await this.sendOutputImages(chatId, processor, lastState);
    } catch (err: any) {
      this.logger.error({ err, chatId }, 'Claude continuation error');

      const errorState: CardState = {
        status: 'error',
        userPrompt: displayPrompt,
        responseText: lastState.responseText,
        toolCalls: lastState.toolCalls,
        errorMessage: err.message || 'Unknown error',
      };
      await rateLimiter.flush();
      await this.sender.updateCard(messageId, buildCard(errorState));
    } finally {
      this.runningTasks.delete(chatId);
      // Cleanup temp image
      if (imagePath) {
        try { fs.unlinkSync(imagePath); } catch { /* ignore */ }
      }
    }
  }

  destroy(): void {
    // Abort all running tasks
    for (const [chatId, task] of this.runningTasks) {
      task.abortController.abort();
      this.logger.info({ chatId }, 'Aborted running task during shutdown');
    }
    this.runningTasks.clear();
    this.sessionManager.destroy();
  }
}
