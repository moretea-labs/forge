import { invoke } from '@tauri-apps/api/core';
export type LocalProviderChoice = 'codex' | 'api';
export interface LocalApiSettings { provider: LocalProviderChoice; endpoint: string; model: string; hasKey: boolean }
export const readLocalApiSettings = (): Promise<LocalApiSettings> => invoke('read_local_api_settings');
export const clearLocalApiKey = (): Promise<LocalApiSettings> => invoke('clear_local_api_key');
export const saveLocalApiSettings = (input: { provider: LocalProviderChoice; endpoint: string; model: string; apiKey?: string }): Promise<LocalApiSettings> => invoke('save_local_api_settings', input);
export async function sendLocalApiConversation(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
  const result = await invoke<{ output: string }>('send_local_api_conversation', { messages });
  return result.output;
}
