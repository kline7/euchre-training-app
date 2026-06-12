import type { ClientAction, ClientMessage, ServerMessage } from './protocol';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface MatchClientEvents {
  onMessage: (msg: ServerMessage) => void;
  onStatus: (status: ConnectionStatus) => void;
}

/**
 * WebSocket client for multiplayer. Auto-reconnects with backoff and
 * re-authenticates; the server re-attaches live matches on reconnect.
 */
export class MatchClient {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  private token: string;
  private events: MatchClientEvents;

  constructor(token: string, events: MatchClientEvents) {
    this.token = token;
    this.events = events;
  }

  connect() {
    this.closedByUser = false;
    this.open();
  }

  private wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${location.host}/ws`;
  }

  private open() {
    if (this.ws) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.sendRaw({ type: 'auth', token: this.token });
      // Keepalive: idle proxies/NAT drop quiet sockets — ping every 30s
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendRaw({ type: 'ping' }), 30_000);
    };

    ws.onmessage = (evt) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(evt.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'auth_ok') {
        this.setStatus('connected');
      }
      this.events.onMessage(msg);
    };

    ws.onclose = () => {
      this.ws = null;
      this.stopHeartbeat();
      this.setStatus('disconnected');
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose follows; nothing else to do
    };
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status !== status) {
      this.status = status;
      this.events.onStatus(status);
    }
  }

  private sendRaw(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  joinQueue(trumpMustBeBroken = true) {
    this.sendRaw({ type: 'queue_join', trumpMustBeBroken });
  }

  leaveQueue() {
    this.sendRaw({ type: 'queue_leave' });
  }

  sendAction(action: ClientAction) {
    this.sendRaw({ type: 'action', action });
  }

  partyInvite(username: string) {
    this.sendRaw({ type: 'party_invite', username });
  }

  partyRespond(accept: boolean) {
    this.sendRaw({ type: 'party_respond', accept });
  }

  partyLeave() {
    this.sendRaw({ type: 'party_leave' });
  }

  teamQueueJoin(trumpMustBeBroken = true) {
    this.sendRaw({ type: 'team_queue_join', trumpMustBeBroken });
  }

  teamQueueLeave() {
    this.sendRaw({ type: 'team_queue_leave' });
  }

  teamPlayAi(difficulty: number, trumpMustBeBroken = true) {
    this.sendRaw({ type: 'team_play_ai', difficulty, trumpMustBeBroken });
  }

  close() {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus('disconnected');
  }
}
