import { create } from 'zustand';

/**
 * The state of the events socket.
 * connecting: first attempt, nothing received yet.
 * open: greeted by the server, stores are live.
 * reconnecting: the socket dropped; stores hold the last known state.
 */
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting';

interface ConnectionState {
  status: ConnectionStatus;
  /** When the socket last opened, milliseconds since the epoch. */
  since: number | null;
  setStatus(status: ConnectionStatus): void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'connecting',
  since: null,
  setStatus: (status) => set(status === 'open' ? { status, since: Date.now() } : { status }),
}));
