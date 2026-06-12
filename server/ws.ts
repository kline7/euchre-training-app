import type { Hono } from 'hono';
import { createNodeWebSocket } from '@hono/node-ws';
import type { WSContext } from 'hono/ws';
import { resolveToken, profileFor } from './auth.js';
import { Matchmaker } from './matchmaking.js';
import { PartyManager } from './party.js';
import type { SeatMessage, ClientAction, MatchTimings } from './match.js';
import { DEFAULT_TIMINGS } from './match.js';

/**
 * WebSocket wire protocol.
 *
 * client → server:
 *   {type:'auth', token}            authenticate this socket (required first)
 *   {type:'queue_join'}             enter elo matchmaking
 *   {type:'queue_leave'}            leave the queue
 *   {type:'action', action}         submit a match action (bid/play/discard)
 *   {type:'ping'}
 *
 * server → client:
 *   {type:'auth_ok', profile}       (or {type:'error'} and the socket closes)
 *   {type:'queue_status', position, waitedMs}
 *   {type:'match_found', matchId, seat}
 *   {type:'state' | 'hand_result' | 'game_over' | 'error' | 'opponent_connection', ...}
 *   {type:'pong'}
 */

type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'queue_join' }
  | { type: 'queue_leave' }
  | { type: 'action'; action: ClientAction }
  | { type: 'party_invite'; username: string }
  | { type: 'party_respond'; accept: boolean }
  | { type: 'party_leave' }
  | { type: 'team_queue_join' }
  | { type: 'team_queue_leave' }
  | { type: 'team_play_ai'; difficulty: number }
  | { type: 'ping' };

interface Connection {
  userId: number;
  username: string;
  ws: WSContext;
}

export function setupWebSocket(app: Hono, timings: MatchTimings = DEFAULT_TIMINGS) {
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: app as never });

  const connections = new Map<number, Connection>();

  const sendTo = (userId: number, payload: unknown) => {
    const conn = connections.get(userId);
    if (conn) {
      try {
        conn.ws.send(JSON.stringify(payload));
      } catch {
        // Socket is dying; the close handler will clean up
      }
    }
  };

  const matchmaker = new Matchmaker(
    (userId, _seat, msg: SeatMessage) => sendTo(userId, msg),
    (userId, position, waitedMs) => sendTo(userId, { type: 'queue_status', position, waitedMs }),
    (userId, matchId, seat) => {
      sendTo(userId, { type: 'match_found', matchId, seat });
      // Queue/in-game counts just changed — push fresh presence promptly
      broadcastPresence();
    },
    timings,
  );

  const parties = new PartyManager({
    isOnline: (userId) => connections.has(userId),
    sendTo: (userId, msg) => sendTo(userId, msg),
    // Party composition changed — a queued duo is no longer valid
    onPartyChanged: (partyId) => matchmaker.leaveTeamQueue(partyId),
  });

  // --- Presence: how many players are online / queueing / in a game ---

  const getPresence = () => ({
    online: connections.size,
    inQueue: matchmaker.queuedUserCount(),
    inGame: matchmaker.matchByUser.size,
  });

  let lastPresenceKey = '';
  const broadcastPresence = (force = false) => {
    const presence = getPresence();
    const key = `${presence.online}:${presence.inQueue}:${presence.inGame}`;
    if (!force && key === lastPresenceKey) return;
    lastPresenceKey = key;
    const payload = JSON.stringify({ type: 'presence', ...presence });
    for (const conn of connections.values()) {
      try {
        conn.ws.send(payload);
      } catch {
        /* dying socket; close handler cleans up */
      }
    }
  };
  const presenceTimer = setInterval(() => broadcastPresence(), 2_000);
  presenceTimer.unref?.();

  // Public counts — no auth needed, nothing sensitive
  app.get('/api/presence', (c) => c.json(getPresence()));

  app.get(
    '/ws',
    upgradeWebSocket(() => {
      // Per-socket state
      let authed: { userId: number; username: string } | null = null;
      let myConn: Connection | null = null;

      return {
        onMessage(evt, ws) {
          let msg: ClientMessage;
          try {
            msg = JSON.parse(String(evt.data));
          } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'invalid JSON' }));
            return;
          }

          if (msg.type === 'auth') {
            const user = typeof msg.token === 'string' ? resolveToken(msg.token) : undefined;
            if (!user) {
              ws.send(JSON.stringify({ type: 'error', message: 'invalid token' }));
              ws.close(4001, 'unauthorized');
              return;
            }
            // One live socket per user: replace any previous connection
            const existing = connections.get(user.id);
            if (existing) {
              try {
                existing.ws.close(4002, 'replaced by new connection');
              } catch {
                /* ignore */
              }
            }
            authed = { userId: user.id, username: user.username };
            myConn = { userId: user.id, username: user.username, ws };
            connections.set(user.id, myConn);
            ws.send(JSON.stringify({ type: 'auth_ok', profile: profileFor(user) }));
            ws.send(JSON.stringify({ type: 'presence', ...getPresence() }));
            // Reconnect to a live match if there is one
            const match = matchmaker.matchFor(user.id);
            if (match) {
              const seat = match.seatOf(user.id);
              if (seat !== undefined) {
                ws.send(JSON.stringify({ type: 'match_found', matchId: match.id, seat }));
                match.setConnected(user.id, true);
              }
            }
            return;
          }

          if (!authed) {
            ws.send(JSON.stringify({ type: 'error', message: 'authenticate first' }));
            return;
          }

          switch (msg.type) {
            case 'queue_join': {
              if (parties.partyOf(authed.userId)) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'leave your party to queue solo (or queue as a team)',
                  }),
                );
                return;
              }
              const { error } = matchmaker.join(authed.userId, authed.username);
              if (error) {
                ws.send(JSON.stringify({ type: 'error', message: error }));
                // If they're "already in a match", re-attach them to it
                const match = matchmaker.matchFor(authed.userId);
                if (match) {
                  const seat = match.seatOf(authed.userId);
                  if (seat !== undefined) {
                    ws.send(JSON.stringify({ type: 'match_found', matchId: match.id, seat }));
                    match.setConnected(authed.userId, true);
                  }
                }
              }
              break;
            }
            case 'queue_leave':
              matchmaker.leave(authed.userId);
              ws.send(JSON.stringify({ type: 'queue_left' }));
              break;
            case 'party_invite': {
              if (typeof msg.username !== 'string') {
                ws.send(JSON.stringify({ type: 'error', message: 'invalid invite' }));
                return;
              }
              const { error } = parties.invite(authed.userId, authed.username, msg.username);
              if (error) ws.send(JSON.stringify({ type: 'error', message: error }));
              else ws.send(JSON.stringify({ type: 'party_invite_sent', to: msg.username }));
              break;
            }
            case 'party_respond': {
              const { error } = parties.respond(
                authed.userId,
                authed.username,
                msg.accept === true,
              );
              if (error) ws.send(JSON.stringify({ type: 'error', message: error }));
              break;
            }
            case 'party_leave':
              parties.leave(authed.userId);
              break;
            case 'team_queue_join': {
              const duo = parties.duoOf(authed.userId);
              if (!duo) {
                ws.send(JSON.stringify({ type: 'error', message: 'you need a full party of 2 to queue as a team' }));
                return;
              }
              if (duo.leaderId !== authed.userId) {
                ws.send(JSON.stringify({ type: 'error', message: 'only the party leader can start the queue' }));
                return;
              }
              const { error } = matchmaker.joinTeamQueue(duo.partyId, duo.users);
              if (error) ws.send(JSON.stringify({ type: 'error', message: error }));
              else {
                for (const u of duo.users) sendTo(u.userId, { type: 'team_queue_joined' });
              }
              break;
            }
            case 'team_queue_leave': {
              const duo = parties.duoOf(authed.userId);
              if (duo) {
                matchmaker.leaveTeamQueue(duo.partyId);
                for (const u of duo.users) sendTo(u.userId, { type: 'queue_left' });
              }
              break;
            }
            case 'team_play_ai': {
              const duo = parties.duoOf(authed.userId);
              if (!duo) {
                ws.send(JSON.stringify({ type: 'error', message: 'you need a full party of 2 to play vs AI' }));
                return;
              }
              if (duo.leaderId !== authed.userId) {
                ws.send(JSON.stringify({ type: 'error', message: 'only the party leader can start a match' }));
                return;
              }
              const difficulty =
                Number.isInteger(msg.difficulty) && msg.difficulty >= 0 && msg.difficulty <= 3
                  ? msg.difficulty
                  : 3;
              matchmaker.leaveTeamQueue(duo.partyId);
              const { error } = matchmaker.startTeamVsAi(duo.users, difficulty);
              if (error) ws.send(JSON.stringify({ type: 'error', message: error }));
              break;
            }
            case 'action': {
              const match = matchmaker.matchFor(authed.userId);
              if (!match) {
                ws.send(JSON.stringify({ type: 'error', message: 'not in a match' }));
                return;
              }
              match.handleAction(authed.userId, msg.action);
              break;
            }
            case 'ping':
              ws.send(JSON.stringify({ type: 'pong' }));
              break;
            default:
              ws.send(JSON.stringify({ type: 'error', message: 'unknown message type' }));
          }
        },

        onClose() {
          if (!authed || !myConn) return;
          // A replaced socket must not tear down its successor's state
          if (connections.get(authed.userId) !== myConn) return;
          connections.delete(authed.userId);
          matchmaker.leave(authed.userId);
          // Dissolve any party (also removes the duo from the team queue)
          parties.handleDisconnect(authed.userId);
          const match = matchmaker.matchFor(authed.userId);
          match?.setConnected(authed.userId, false);
        },
      };
    }),
  );

  return {
    injectWebSocket,
    matchmaker,
    parties,
    getPresence,
    stopPresence: () => clearInterval(presenceTimer),
  };
}
