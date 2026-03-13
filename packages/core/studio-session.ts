const SESSION_ID_LENGTH = 4;
const SESSION_ID_PATTERN = /^[a-z0-9]{4}$/;
const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function buildStudioBranchName(mainHash: string, sessionId: string): string {
  return `studio/session-${mainHash}-${sessionId}`;
}

export function parseStudioBranchName(
  branch: string,
  mainHash: string,
): { sessionId: string } | null {
  const pattern = new RegExp(`^studio/session-${mainHash}-[a-z0-9]{4}$`);
  if (!pattern.test(branch)) return null;
  return { sessionId: branch.slice(`studio/session-${mainHash}-`.length) };
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

export function generateSessionId(randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(SESSION_ID_LENGTH));
  let sessionId = '';
  for (let i = 0; i < SESSION_ID_LENGTH; i += 1) {
    sessionId += SESSION_ID_ALPHABET[bytes[i] % SESSION_ID_ALPHABET.length];
  }
  return sessionId;
}

type ResolveStudioSessionOptions = {
  currentBranch: string;
  mainHash: string;
};

type ResolveStudioSessionResult = {
  branch: string;
  sessionId: string;
};

export function resolveStudioSession({
  currentBranch,
  mainHash,
}: ResolveStudioSessionOptions): ResolveStudioSessionResult {
  const parsed = parseStudioBranchName(currentBranch, mainHash);
  if (!parsed) {
    throw new Error(`Studio requires a branch named studio/session-${mainHash}-<session-id>.`);
  }

  return {
    branch: currentBranch,
    sessionId: parsed.sessionId,
  };
}
