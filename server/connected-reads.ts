// The calendar events and email headers a routine's checks read with no AI turn, and the reader they read through.
// MausBot has no reader of its own: the Environment's integrations belong to the agents, never to the server.

export const READ_APPS = ["gmail", "googlecalendar"] as const;
export type ReadApp = (typeof READ_APPS)[number];

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  selfDeclined: boolean;
  attendees: Array<{ email: string; name?: string; self: boolean; organizer: boolean; response?: string }>;
  seriesId?: string;
  joinUrl?: string;
  location?: string;
  description?: string;
  calendarId?: string;
  ownedCalendar?: boolean;
  iCalUID?: string;
  originalStart?: number;
  organizer?: string;
}

export interface EmailHeader {
  id: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  preview: string;
}

export interface ThreadMessage {
  id: string;
  at: number;
  /** The sender's lower-case address, or "" when the answer named none. */
  from: string;
}

const SIGNED_OUT = /\b(?:unauthori[sz]ed|unauthenticated|invalid[_ ]grant|expired|re-?connect|not connected|no connected account|not active|initiated|initializing|permission denied|forbidden|401|403)\b/i;

/** A read that failed: the app, what went wrong, and whether reconnecting the app is what fixes it. */
export class SourceError extends Error {
  readonly app: ReadApp;
  readonly signedOut: boolean;
  constructor(app: ReadApp, message: string) {
    super(message);
    this.app = app;
    this.signedOut = SIGNED_OUT.test(message);
    this.name = "SourceError";
  }
}

/** The reads one check makes, over one connected-apps session. */
export interface ReadSession {
  events(fromMs: number, toMs: number): Promise<CalendarEvent[]>;
  /** Inbox mail since `sinceMs`, newest first, at most `limit`; `more` when there was more than that. */
  emails(sinceMs: number, limit: number): Promise<{ emails: EmailHeader[]; more: boolean }>;
  /** Null only when Gmail says the message is gone. */
  message(messageId: string): Promise<EmailHeader | null>;
  thread(threadId: string): Promise<ThreadMessage[]>;
  /** The connected Gmail account's own address. */
  address(): Promise<string>;
}

export interface ConnectedReads {
  connected(): Promise<Record<ReadApp, boolean> | null>;
  session(): ReadSession;
}

