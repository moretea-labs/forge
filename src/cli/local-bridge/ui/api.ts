import type { AutomationSettingsView, AutomationsResponse, CommandCenterView, Dict, WorkResponse } from './types';

export class ApiError extends Error { constructor(message: string, readonly status: number, readonly payload: unknown) { super(message); } }
export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  let payload: unknown = {};
  try { payload = await response.json(); } catch { /* non-json failure */ }
  if (!response.ok) {
    const record = payload && typeof payload === 'object' ? payload as Dict : {};
    const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload as T;
}
export const api = {
  commandCenter: () => requestJson<CommandCenterView>('/api/console/command-center'),
  work: () => requestJson<WorkResponse>('/api/console/requirements'),
  automations: () => requestJson<AutomationsResponse>('/api/console/automations'),
  automationSettings: () => requestJson<AutomationSettingsView>('/api/console/automation-settings'),
  connector: () => requestJson<Dict>('/api/console/connector/status'),
  advanced: () => requestJson<Dict>('/api/console/advanced'),
  automationAction: (source: string, repoId: string, id: string, action: string) => requestJson<Dict>(`/api/console/automations/${encodeURIComponent(source)}/${encodeURIComponent(repoId)}/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: 'POST', body: '{}' }),
  providerAction: (id: string, action: 'enable'|'disable') => requestJson<Dict>(`/api/console/providers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' }),
  providerHealth: (id: string) => requestJson<Dict>('/api/console/providers/health', { method: 'POST', body: JSON.stringify({ providerId: id }) }),
  localToolAction: (id: string, action: 'enable'|'disable') => requestJson<Dict>(`/api/console/local-tools/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' }),
  localToolHealth: (id: string) => requestJson<Dict>('/api/console/local-tools/health', { method: 'POST', body: JSON.stringify({ toolId: id }) }),
  registerRepository: (path: string, displayName?: string) => requestJson<Dict>('/api/repositories/register', { method: 'POST', body: JSON.stringify({ path, displayName }) }),
  removeRepository: (id: string) => requestJson<Dict>(`/api/repositories/${encodeURIComponent(id)}/remove`, { method: 'POST', body: '{}' }),
};
