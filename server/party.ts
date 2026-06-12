import { randomUUID } from 'node:crypto';
import { areFriends, getOrCreateTeam, getRating, getUserByName, type RatingRow, type UserRow } from './db.js';
import { divisionFor } from './elo.js';

/**
 * Pre-made team lobby ("party"). A party is two friends who queue together.
 * Parties are transient (in-memory); the duo's persistent rating lives in the
 * `teams` table and is created/loaded when they first queue rated.
 */

export interface PartyMemberView {
  username: string;
  elo: number;
  division: string;
  leader: boolean;
}

export interface PartyView {
  members: PartyMemberView[];
  /** Persistent duo rating (combined-start), present once both members joined. */
  teamElo: number | null;
  teamDivision: string | null;
  teamRecord: { gamesPlayed: number; wins: number } | null;
  full: boolean;
}

interface Party {
  id: string;
  leaderId: number;
  leaderName: string;
  memberId: number | null;
  memberName: string | null;
}

interface Invite {
  partyId: string;
  fromUserId: number;
  fromUsername: string;
}

export interface PartyEvents {
  isOnline: (userId: number) => boolean;
  /** Send an arbitrary protocol message to a user. */
  sendTo: (userId: number, msg: unknown) => void;
  /** Called when party composition changes so queues can be revalidated. */
  onPartyChanged: (partyId: string) => void;
}

export class PartyManager {
  private parties = new Map<string, Party>();
  private partyByUser = new Map<number, string>();
  /** One pending invite per invitee (latest wins). */
  private invites = new Map<number, Invite>();

  constructor(private events: PartyEvents) {}

  partyOf(userId: number): Party | undefined {
    const id = this.partyByUser.get(userId);
    return id ? this.parties.get(id) : undefined;
  }

  /** Both members of the user's party, or null when not in a full party. */
  duoOf(userId: number): {
    partyId: string;
    leaderId: number;
    users: { userId: number; username: string }[];
  } | null {
    const party = this.partyOf(userId);
    if (!party || party.memberId === null) return null;
    return {
      partyId: party.id,
      leaderId: party.leaderId,
      users: [
        { userId: party.leaderId, username: party.leaderName },
        { userId: party.memberId, username: party.memberName! },
      ],
    };
  }

  view(userId: number): PartyView | null {
    const party = this.partyOf(userId);
    if (!party) return null;
    const members: PartyMemberView[] = [];
    for (const [id, name, leader] of [
      [party.leaderId, party.leaderName, true] as const,
      ...(party.memberId !== null
        ? [[party.memberId, party.memberName!, false] as const]
        : []),
    ]) {
      const elo = (getRating.get(id) as RatingRow | undefined)?.elo ?? 1200;
      members.push({ username: name, elo, division: divisionFor(elo), leader });
    }

    let teamElo: number | null = null;
    let teamDivision: string | null = null;
    let teamRecord: PartyView['teamRecord'] = null;
    if (party.memberId !== null) {
      const team = getOrCreateTeam(party.leaderId, party.memberId);
      teamElo = team.elo;
      teamDivision = divisionFor(team.elo);
      teamRecord = { gamesPlayed: team.games_played, wins: team.wins };
    }

    return { members, teamElo, teamDivision, teamRecord, full: party.memberId !== null };
  }

  private pushUpdate(party: Party) {
    for (const id of [party.leaderId, party.memberId]) {
      if (id !== null) {
        this.events.sendTo(id, { type: 'party_update', party: this.view(id) });
      }
    }
    this.events.onPartyChanged(party.id);
  }

  /** Invite an online friend into a party (creating the party if needed). */
  invite(fromUserId: number, fromUsername: string, toUsername: string): { error?: string } {
    const target = getUserByName.get(toUsername) as UserRow | undefined;
    if (!target) return { error: 'No such player' };
    if (target.id === fromUserId) return { error: 'You cannot invite yourself' };
    if (!areFriends(fromUserId, target.id)) {
      return { error: 'You can only invite friends — add them first' };
    }
    if (!this.events.isOnline(target.id)) return { error: `${toUsername} is not online` };
    if (this.partyByUser.has(target.id)) return { error: `${toUsername} is already in a party` };

    let party = this.partyOf(fromUserId);
    if (party && party.memberId !== null) return { error: 'Your party is already full' };
    if (party && party.leaderId !== fromUserId) return { error: 'Only the party leader can invite' };
    if (!party) {
      party = {
        id: randomUUID(),
        leaderId: fromUserId,
        leaderName: fromUsername,
        memberId: null,
        memberName: null,
      };
      this.parties.set(party.id, party);
      this.partyByUser.set(fromUserId, party.id);
      this.pushUpdate(party);
    }

    this.invites.set(target.id, {
      partyId: party.id,
      fromUserId,
      fromUsername,
    });
    this.events.sendTo(target.id, { type: 'party_invite_received', from: fromUsername });
    return {};
  }

  respond(userId: number, username: string, accept: boolean): { error?: string } {
    const invite = this.invites.get(userId);
    if (!invite) return { error: 'No pending party invite' };
    this.invites.delete(userId);

    const party = this.parties.get(invite.partyId);
    if (!accept) {
      if (party) this.events.sendTo(party.leaderId, { type: 'party_invite_declined', by: username });
      return {};
    }
    if (!party || party.memberId !== null) return { error: 'That party no longer has room' };
    if (this.partyByUser.has(userId)) return { error: 'Leave your current party first' };

    party.memberId = userId;
    party.memberName = username;
    this.partyByUser.set(userId, party.id);
    this.pushUpdate(party);
    return {};
  }

  /** Leaving a two-person party dissolves it. */
  leave(userId: number) {
    const party = this.partyOf(userId);
    if (!party) return;
    this.parties.delete(party.id);
    for (const id of [party.leaderId, party.memberId]) {
      if (id !== null) {
        this.partyByUser.delete(id);
        this.events.sendTo(id, { type: 'party_update', party: null });
      }
    }
    this.events.onPartyChanged(party.id);
  }

  /** Disconnect cleanup: drop invites and dissolve any party. */
  handleDisconnect(userId: number) {
    this.invites.delete(userId);
    this.leave(userId);
  }
}
