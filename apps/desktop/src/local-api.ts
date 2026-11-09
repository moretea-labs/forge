import { invoke } from '@tauri-apps/api/core';

export type LocalProviderChoice = 'codex' | 'api' | 'joycode';
export type LocalApiProtocol = 'openai' | 'anthropic' | 'responses';

export interface ApiProviderProfile {
  id: string;
  providerId: string;
  label: string;
  endpoint: string;
  model: string;
  apiProtocol: LocalApiProtocol;
  credentialRef?: string | null;
  hasKey: boolean;
  endpointReady: boolean;
}

export interface LocalApiSettings {
  schemaVersion: 2;
  defaultProvider: string;
  profiles: ApiProviderProfile[];
  joyCodeModel: string;
  joyCodeReady: boolean;

  // Legacy React surface projection. These are derived from the v2 default
  // profile and are never persisted as a second settings schema.
  provider: LocalProviderChoice;
  endpoint: string;
  model: string;
  apiProtocol: LocalApiProtocol;
  credentialRef?: string | null;
  hasKey: boolean;
  endpointReady: boolean;
}

export interface LocalApiToolEvent { name: string; ok: boolean; requestId?: string }
export interface LocalApiConversationResponse {
  output: string;
  toolActivityCount: number;
  toolEvents: LocalApiToolEvent[];
}

export const readLocalApiSettings = (): Promise<LocalApiSettings> => invoke('read_local_api_settings');

type ProfileSaveInput = {
  defaultProvider: string;
  profiles: Array<Pick<ApiProviderProfile, 'id' | 'label' | 'endpoint' | 'model' | 'apiProtocol' | 'credentialRef'>>;
  joyCodeModel?: string;
};
type LegacySaveInput = {
  provider: LocalProviderChoice;
  endpoint: string;
  model: string;
  apiProtocol: LocalApiProtocol;
  credentialRef?: string;
  joyCodeModel?: string;
};

const profileInput = (profile: ApiProviderProfile) => ({
  id: profile.id, label: profile.label, endpoint: profile.endpoint, model: profile.model,
  apiProtocol: profile.apiProtocol, credentialRef: profile.credentialRef ?? undefined,
});

export async function saveLocalApiSettings(input: ProfileSaveInput | LegacySaveInput): Promise<LocalApiSettings> {
  if ('profiles' in input) return invoke('save_local_api_settings', input);

  const current = await readLocalApiSettings();
  const profiles = current.profiles.map(profileInput);
  let defaultProvider: string = input.provider;
  const shouldPersistProfile = input.provider === 'api'
    || input.model.trim().length > 0
    || Boolean(input.credentialRef)
    || input.endpoint.trim() !== 'https://api.openai.com/v1';
  if (shouldPersistProfile) {
    const currentId = current.defaultProvider.startsWith('api:') ? current.defaultProvider.slice(4) : undefined;
    const index = currentId ? profiles.findIndex(profile => profile.id === currentId) : 0;
    const id = index >= 0 ? profiles[index]!.id : 'legacy-web';
    const next = {
      id,
      label: index >= 0 ? profiles[index]!.label : 'Compatible API',
      endpoint: input.endpoint,
      model: input.model,
      apiProtocol: input.apiProtocol,
      credentialRef: input.credentialRef,
    };
    if (index >= 0) profiles[index] = next;
    else profiles.push(next);
    if (input.provider === 'api') defaultProvider = 'api:' + id;
  }
  return invoke('save_local_api_settings', {
    defaultProvider,
    profiles,
    joyCodeModel: input.joyCodeModel ?? current.joyCodeModel,
  });
}

export const sendLocalApiConversation = (input: {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  repoId?: string;
  checkoutId?: string;
  conversationId: string;
  provider?: string;
  model?: string;
}): Promise<LocalApiConversationResponse> => invoke('send_local_api_conversation', input);

export const cancelLocalApiConversation = (conversationId: string):
  Promise<{ requested: boolean; conversationId: string }> =>
  invoke('cancel_local_api_conversation', { conversationId });
