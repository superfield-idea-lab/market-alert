export interface StudioInfo {
  sessionId: string;
  branch: string;
}

export interface StudioMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function parseStudioInfo(raw: string): StudioInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StudioInfo>;
    if (typeof parsed.sessionId !== 'string' || typeof parsed.branch !== 'string') {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      branch: parsed.branch,
    };
  } catch {
    return null;
  }
}

export function parseSessionCommits(output: string): { hash: string; message: string }[] {
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const spaceIdx = line.indexOf(' ');
      return { hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) };
    });
}

export function validateStudioMessage(message: unknown): string | null {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  return trimmed ? trimmed : null;
}

export function validateRollbackHash(hash: unknown): string | null {
  if (typeof hash !== 'string') return null;
  const trimmed = hash.trim();
  return trimmed ? trimmed : null;
}

export function getStudioSystemPrompt(branch: string): string {
  return `You are a studio mode agent for Calypso. You are helping a business partner explore UI and workflow changes to the Calypso application in a live session.

## Your Role

You make changes to the codebase based on the partner's plain-language feedback. You can touch any file in the repository — frontend, backend, schema, packages. This is an exploratory session on a throwaway branch (${branch}). Things can break. That is fine.

## After Every Turn

After making changes, you MUST:
1. Update \`docs/studio-sessions/${branch}/changes.md\` with a new section describing what you changed and why. If the file doesn't exist, create it with a header. Always append — never overwrite prior turns.
2. Run: git add -A && git commit --no-verify -m "<short description of this turn>"

## Changes Narrative Format

Append to \`docs/studio-sessions/${branch}/changes.md\` after each turn:

### Turn N — <short title>
<What changed, why the partner wanted it, what it looks like now>
<If backend/schema changes are needed that you didn't implement: **Requires backend:** description>

## Important

- The Postgres DB is disposable. If you change the schema, note that a container reset will break the session unless seeds are updated.
- Keep your reply to the partner short and conversational. Describe what you did in plain language.
- Do not ask clarifying questions unless absolutely necessary. Make a reasonable interpretation and proceed.`;
}

export function buildStudioPrompt({
  branch,
  messages,
  changesContent,
}: {
  branch: string;
  messages: StudioMessage[];
  changesContent?: string;
}): string {
  const conversationText = messages
    .map((message) => `${message.role === 'user' ? 'Partner' : 'Agent'}: ${message.content}`)
    .join('\n\n');

  const changesContext = changesContent
    ? `\n\nCurrent changes.md:\n\`\`\`\n${changesContent}\n\`\`\``
    : '';

  return `${getStudioSystemPrompt(branch)}${changesContext}\n\n## Conversation\n\n${conversationText}\n\nAgent:`;
}
