/** Public browser contracts contain data only; no Discord or server imports. */
export interface WebUser { discordId: string; mustChangePassword: boolean; }
export interface AuthState {
  user: WebUser;
  scope: 'full' | 'password_change';
  csrfToken: string;
  expiresAt: number;
}
export interface ApiError { error: string; code?: string; }
export interface Song {
  id: string;
  title: string;
  artist?: string | null;
  durationSeconds?: number | null;
  mimeType: string;
  byteSize: number;
  sha256: string;
}
export interface SongPage { items: Song[]; nextCursor?: string | null; }
export interface PlaylistEntry {
  entryId: string;
  source: 'local' | 'remote';
  id: string;
  title: string;
  artist?: string;
  library?: string;
  browserPlayable: boolean;
}
export interface Playlist {
  id: string;
  ownerId: string;
  name: string;
  revision: number;
  entries: PlaylistEntry[];
}
export interface PlaylistPage { items: Playlist[]; }
export interface VoiceContext {
  guildId: string;
  guildName: string;
  channelId: string;
  channelName: string;
  botChannelId: string | null;
}
export type RepeatMode = 'off' | 'one' | 'all';
export interface PlaybackTrack {
  id: string;
  source: 'local' | 'remote';
  title: string;
  artist?: string;
  durationSeconds?: number;
}
export interface PlaybackEntry { track: PlaybackTrack; requestedBy: string; }
export interface PlayerSnapshot {
  guildId: string;
  channelId: string;
  sessionId: string | null;
  generation: number;
  queueRevision: number;
  status: 'idle' | 'connecting' | 'playing' | 'paused' | 'ended';
  current: PlaybackEntry | null;
  pending: PlaybackEntry[];
  volume: number;
  repeat: RepeatMode;
  elapsedSeconds: number;
  durationSeconds?: number;
  observedAt: string;
  canControl: boolean;
  canPlay: boolean;
  historyCount: number;
  notice?: string;
}
export interface CommandContext {
  requestId: string;
  sessionId: string | null;
  generation?: number;
  queueRevision?: number;
}
export type PlayerCommand = CommandContext & (
  | { action: 'enqueue'; songIds?: string[]; playlistId?: string; position?: 'last' | 'next' }
  | { action: 'pause' | 'resume' | 'skip' | 'previous' | 'restart' | 'shuffle' | 'clear' | 'stop' }
  | { action: 'seek'; seconds: number }
  | { action: 'volume'; percent: number }
  | { action: 'repeat'; mode: RepeatMode }
  | { action: 'remove'; position: number }
  | { action: 'move'; from: number; to: number }
);
export interface CommandResult { snapshot: PlayerSnapshot; skipped?: number; }
