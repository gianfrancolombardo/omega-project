export type AddressForm = "vos" | "usted";

export type FactCategory =
  | "gusto"
  | "disgusto"
  | "interes"
  | "familia"
  | "lugar"
  | "epoca"
  | "fecha"
  | "historia"
  | "opinion"
  | "rutina"
  | "salud"
  | "meta"
  | "otro";

export const FACT_CATEGORIES: FactCategory[] = [
  "gusto",
  "disgusto",
  "interes",
  "familia",
  "lugar",
  "epoca",
  "fecha",
  "historia",
  "opinion",
  "rutina",
  "salud",
  "meta",
  "otro",
];

export type FactSource = "tool" | "setup" | "summary";

export type Fact = {
  id: string;
  category: FactCategory;
  content: string;
  createdAt: string;
  updatedAt?: string | null;
  sourceSessionId: string | null;
  source: FactSource;
};

export type Profile = {
  displayName: string;
  addressForm: AddressForm;
  timezone: string;
  dailyTime: string;
  proactiveEnabled: boolean;
  tastes: string;
  lifeNotes: string;
  avoidTopics: string;
  importantPeople: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  reducedHearing: boolean;
  subtitles: boolean;
  userConsentAt: string | null;
  memoryDeclinedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProfilePatch = {
  displayName?: string;
  addressForm?: AddressForm;
  timezone?: string;
  dailyTime?: string;
  proactiveEnabled?: boolean;
  tastes?: string;
  lifeNotes?: string;
  avoidTopics?: string;
  importantPeople?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  emergencyRelation?: string;
  reducedHearing?: boolean;
  subtitles?: boolean;
};

export type TranscriptTurn = {
  role: "user" | "assistant";
  text: string;
  at: string;
};

export type SessionStatus =
  | "active"
  | "completed"
  | "accidental"
  | "declined"
  | "no_response"
  | "error";

export type SessionInitiator = "user" | "proactive";

export type NormalizedUsage = {
  inputText: number;
  inputAudio: number;
  cachedText: number;
  cachedAudio: number;
  outputText: number;
  outputAudio: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export const EMPTY_USAGE: NormalizedUsage = {
  inputText: 0,
  inputAudio: 0,
  cachedText: 0,
  cachedAudio: 0,
  outputText: 0,
  outputAudio: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export type SessionRecord = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  initiator: SessionInitiator;
  module: string;
  status: SessionStatus;
  transcript: TranscriptTurn[];
  summary: string;
  openThreads: string[];
  durationSeconds: number | null;
  userWords: number;
  agentWords: number;
  misunderstoodCount: number;
  elderspeakHits: number;
  usage: NormalizedUsage;
  costUsd: number | null;
  costApproximate: boolean;
  model: string;
  voice: string;
  summarySource: "model" | "fallback" | null;
};

export type MoodInstrument = "ucla3" | "who5" | "phq2" | "daily";

export type MoodSignal = {
  id: string;
  sessionId: string | null;
  instrument: MoodInstrument;
  itemId: string;
  rawAnswer: string;
  score: number | null;
  note: string;
  createdAt: string;
};

export type AlertKind = "suicide" | "emergency" | "distress" | "concern";

export type AlertRecord = {
  id: string;
  sessionId: string | null;
  level: 2 | 3;
  kind: AlertKind;
  reason: string;
  excerpt: string;
  createdAt: string;
  notifyStatus: "stub" | "sent" | "failed";
  notifyDetail: string;
};

export type Microgoal = {
  id: string;
  content: string;
  status: "open" | "done";
  createdAt: string;
  sessionId: string | null;
};

export type ProactiveDay = {
  localDate: string;
  attempts: number;
  declined: boolean;
  engaged: boolean;
  nextRetryAt: string | null;
};

export type ProactiveEvent = "attempt" | "decline" | "engage" | "no_response";
