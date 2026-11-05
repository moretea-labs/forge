import { invoke } from '@tauri-apps/api/core';
export type LocalProviderChoice = 'codex' | 'api';
export type LocalApiProtocol = 'openai' | 'anthropic';
export interface LocalApiSettings {
  provider: LocalProviderChoice;
  endpoint: string;
  model: string;
  apiProtocol: LocalApiProtocol;
  hasKey: boolean;
}
export interface LocalApiToolEvent { name: string; ok: boolean; requestId?: string }
export interface LocalApiConversationResponse {
  output: string;
  toolActivityCount: number;
  toolEvents: LocalApiToolEvent[];
}
export const readLocalApiSettings = (): Promise<LocalApiSettings> => invoke('read_local_api_settings');
export const clearLocalApiKey = (): Promise<LocalApiSettings> => invoke('clear_local_api_key');
export const saveLocalApiSettings = (input: {
  provider: LocalProviderChoice; endpoint: string; model: string;
  apiProtocol: LocalApiProtocol; apiKey?: string;
}): Promise<LocalApiSettings> => invoke('save_local_api_settings', input);
export const sendLocalApiConversation = (input: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  repoId?: string;
  conversationId: string;
  allowEffects: boolean;
}): Promise<LocalApiConversationResponse> => invoke('send_local_api_conversation', input);
