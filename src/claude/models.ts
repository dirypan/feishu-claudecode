// Available Claude models supported by Claude Code CLI
// Based on Anthropic API model naming
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

// Hardcoded fallback list used before SDK fetch or if fetch fails
const FALLBACK_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'Most capable model (latest)',
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
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

let cachedModels: ModelInfo[] = FALLBACK_MODELS;

export function getAvailableModels(): ModelInfo[] {
  return cachedModels;
}

export async function initializeModels(cwd: string): Promise<void> {
  try {
    const stream = query({
      prompt: '',
      options: {
        cwd,
        permissionMode: 'dontAsk',
      } as any,
    });
    const sdkModels = await stream.supportedModels();
    const aliasModels: ModelInfo[] = sdkModels.map((m) => ({
      id: m.value,
      name: m.displayName,
      description: m.description,
    }));
    // Show CLI aliases first (reflect actual installed Claude Code),
    // then append hardcoded versioned IDs for explicit version pinning.
    cachedModels = [...aliasModels, ...FALLBACK_MODELS];
  } catch {
    // Keep hardcoded fallback — SDK fetch is best-effort
  }
}

export function isValidModel(modelId: string): boolean {
  return cachedModels.some((m) => m.id === modelId);
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return cachedModels.find((m) => m.id === modelId);
}
