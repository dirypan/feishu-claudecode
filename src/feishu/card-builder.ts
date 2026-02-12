export type CardStatus = 'thinking' | 'running' | 'complete' | 'error';

export interface ToolCall {
  name: string;
  detail: string;
  status: 'running' | 'done';
}

export interface CardState {
  status: CardStatus;
  userPrompt: string;
  responseText: string;
  toolCalls: ToolCall[];
  costUsd?: number;
  durationMs?: number;
  errorMessage?: string;
}

const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking: { color: 'blue', title: 'Thinking...', icon: '🔵' },
  running: { color: 'blue', title: 'Running...', icon: '🔵' },
  complete: { color: 'green', title: 'Complete', icon: '🟢' },
  error: { color: 'red', title: 'Error', icon: '🔴' },
};

const MAX_CONTENT_LENGTH = 50000; // Increased from 28KB to 50KB for longer responses

function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  const half = Math.floor(MAX_CONTENT_LENGTH / 2) - 50;
  return (
    text.slice(0, half) +
    '\n\n... (content truncated) ...\n\n' +
    text.slice(-half)
  );
}

export function buildCard(state: CardState): string {
  const config = STATUS_CONFIG[state.status];
  const elements: unknown[] = [];

  // Tool calls section (show only latest 20)
  if (state.toolCalls.length > 0) {
    const recentToolCalls = state.toolCalls.slice(-20);
    const toolLines = recentToolCalls.map((t) => {
      const icon = t.status === 'running' ? '⏳' : '✅';
      return `${icon} **${t.name}** ${t.detail}`;
    });

    // Add indicator if there are more tool calls
    if (state.toolCalls.length > 20) {
      toolLines.unshift(`_... (${state.toolCalls.length - 20} earlier tool calls hidden)_`);
    }

    elements.push({
      tag: 'markdown',
      content: toolLines.join('\n'),
    });
    elements.push({ tag: 'hr' });
  }

  // Response content
  if (state.responseText) {
    elements.push({
      tag: 'markdown',
      content: truncateContent(state.responseText),
    });
  } else if (state.status === 'thinking') {
    elements.push({
      tag: 'markdown',
      content: '_Claude is thinking..._',
    });
  }

  // Error message
  if (state.errorMessage) {
    elements.push({
      tag: 'markdown',
      content: `**Error:** ${state.errorMessage}`,
    });
  }

  // Stats note
  if (state.status === 'complete' || state.status === 'error') {
    const parts: string[] = [];
    if (state.durationMs !== undefined) {
      parts.push(`Duration: ${(state.durationMs / 1000).toFixed(1)}s`);
    }
    if (state.costUsd !== undefined) {
      parts.push(`Cost: $${state.costUsd.toFixed(4)}`);
    }
    if (parts.length > 0) {
      elements.push({
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: parts.join(' | '),
          },
        ],
      });
    }
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: config.color,
      title: {
        content: `${config.icon} ${config.title}`,
        tag: 'plain_text',
      },
    },
    elements,
  };

  return JSON.stringify(card);
}

export function buildHelpCard(): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📖 Help',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          '**Available Commands:**',
          '`/cd /path/to/project` - Set working directory',
          '`/reset` - Clear session, start fresh (keeps working directory)',
          '`/show-system-prompt` - Display current system prompt',
          '`/set-system-prompt <text>` - Set custom system prompt',
          '`/reset-system-prompt` - Reset system prompt to default',
          '`/stop` - Abort current running task',
          '`/status` - Show current session and directory info',
          '`/send-file /path/to/file` - Send a file to this chat',
          '`/help` - Show this help message',
          '',
          '**Usage:**',
          'Send any text message to start a conversation with Claude Code.',
          'Claude will execute in the working directory you set with `/cd`.',
          'Each user has an independent session and working directory.',
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildStatusCard(
  userId: string,
  workingDirectory: string | undefined,
  sessionId: string | undefined,
  isRunning: boolean,
): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: {
        content: '📊 Status',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**User:** \`${userId}\``,
          `**Working Directory:** ${workingDirectory ? `\`${workingDirectory}\`` : '_Not set (use /cd to set)_'}`,
          `**Session:** ${sessionId ? `\`${sessionId.slice(0, 8)}...\`` : '_None_'}`,
          `**Running:** ${isRunning ? 'Yes ⏳' : 'No'}`,
        ].join('\n'),
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildTextCard(title: string, content: string, color: string = 'blue'): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: color,
      title: {
        content: title,
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
  return JSON.stringify(card);
}

export function buildContinueCard(currentTurns: number): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: {
        content: '⚠️ Max Turns Reached',
        tag: 'plain_text',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `Claude has reached the maximum turn limit (${currentTurns} turns).\n\nDo you want to continue execution?\n\nReply with **yes** or **no**.`,
      },
    ],
  };
  return JSON.stringify(card);
}
