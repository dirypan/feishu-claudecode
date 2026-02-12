// Available Claude models supported by Claude Code CLI
// Based on Anthropic API model naming

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Most capable model (latest)',
  },
  {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    description: 'Balanced performance and speed (recommended)',
  },
  {
    id: 'claude-haiku-3-5',
    name: 'Claude Haiku 3.5',
    description: 'Fastest model, good for simple tasks',
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet (Oct 2024)',
    description: 'Previous Sonnet version',
  },
  {
    id: 'claude-3-5-haiku-20241022',
    name: 'Claude 3.5 Haiku (Oct 2024)',
    description: 'Previous Haiku version',
  },
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus (Feb 2024)',
    description: 'Previous Opus version',
  },
];

export function isValidModel(modelId: string): boolean {
  return AVAILABLE_MODELS.some((m) => m.id === modelId);
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === modelId);
}
