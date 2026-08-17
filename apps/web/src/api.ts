import type {
  CatalogSource,
  CreateRoomResponse,
  ErrorCode,
  InstanceInfo,
  ResultsResponse,
  RoomView,
} from '@quorum/contracts';

const REQUEST_HEADER = 'x-quorum-request';
const HOST_TOKEN_HEADER = 'x-quorum-host-token';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  hostToken?: string | undefined;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { [REQUEST_HEADER]: '1' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.hostToken !== undefined) {
    headers[HOST_TOKEN_HEADER] = options.hostToken;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach Quorum right now.');
  }

  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error =
      payload !== null && typeof payload === 'object' && 'error' in payload
        ? (payload as { error: ErrorCode; message?: string })
        : { error: 'invalid_request' as ErrorCode, message: 'Request failed' };
    throw new ApiError(
      response.status,
      error.error,
      error.message ?? 'Request failed',
    );
  }
  return payload as T;
}

export const api = {
  catalogSource: async (): Promise<CatalogSource> =>
    request<CatalogSource>('/api/catalog'),

  instance: async (): Promise<InstanceInfo> =>
    request<InstanceInfo>('/api/instance'),

  createRoom: async (): Promise<CreateRoomResponse> =>
    request<CreateRoomResponse>('/api/rooms', { method: 'POST', body: {} }),

  invite: async (
    inviteToken: string,
  ): Promise<{
    roomId: string;
    state: RoomView['state'];
    participants: RoomView['participants'];
  }> => request(`/api/invites/${inviteToken}`),

  join: async (
    inviteToken: string,
    displayName: string,
    hostToken?: string,
  ): Promise<{ participantId: string; room: RoomView }> =>
    request(`/api/invites/${inviteToken}/join`, {
      method: 'POST',
      body: { displayName },
      hostToken,
    }),

  hostJoin: async (
    hostToken: string,
    displayName: string,
  ): Promise<{ participantId: string; room: RoomView }> =>
    request(`/api/host/${hostToken}/join`, {
      method: 'POST',
      body: { displayName },
      hostToken,
    }),

  room: async (roomId: string): Promise<RoomView> =>
    request<RoomView>(`/api/rooms/${roomId}`),

  hostRoom: async (hostToken: string): Promise<RoomView> =>
    request<RoomView>(`/api/host/${hostToken}`),

  start: async (roomId: string, hostToken: string): Promise<RoomView> =>
    request<RoomView>(`/api/rooms/${roomId}/start`, {
      method: 'POST',
      hostToken,
    }),

  continueVoting: async (
    roomId: string,
    hostToken: string,
  ): Promise<RoomView> =>
    request<RoomView>(`/api/rooms/${roomId}/continue`, {
      method: 'POST',
      hostToken,
    }),

  close: async (roomId: string, hostToken: string): Promise<RoomView> =>
    request<RoomView>(`/api/rooms/${roomId}/close`, {
      method: 'POST',
      hostToken,
    }),

  swipe: async (
    roomId: string,
    exposureId: string,
    choice: 'LEFT' | 'RIGHT',
  ): Promise<{ room: RoomView }> =>
    request(`/api/rooms/${roomId}/swipe`, {
      method: 'POST',
      body: { exposureId, choice },
    }),

  results: async (
    roomId: string,
    hostToken?: string,
  ): Promise<ResultsResponse> =>
    request<ResultsResponse>(`/api/rooms/${roomId}/results`, { hostToken }),
};
