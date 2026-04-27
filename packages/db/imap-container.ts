/**
 * @file imap-container.ts
 *
 * DIY Testcontainers for Greenmail — spins up an isolated Greenmail IMAP/SMTP
 * Docker container and tears it down on request.
 *
 * Used exclusively by integration tests. Never imported at runtime.
 *
 * Greenmail provides a lightweight self-contained mail server supporting
 * IMAP4, SMTP, and POP3. It is the canonical test IMAP server referenced in
 * the implementation plan (superfield-distribution/packages/db/imap-container.ts
 * pattern).
 *
 * Port mapping:
 *   3143 → IMAP (STARTTLS)
 *   3993 → IMAPS (TLS)
 *   3025 → SMTP
 *
 * Test credentials:
 *   user: test@localhost.com
 *   password: test123
 *
 * Usage:
 *   const gm = await startGreenmail();
 *   // gm.imapPort  — mapped IMAP port on localhost
 *   // gm.smtpPort  — mapped SMTP port on localhost
 *   // gm.user      — IMAP/SMTP username
 *   // gm.password  — IMAP/SMTP password
 *   // gm.sendMail(subject, body) — helper to inject a test message via SMTP
 *   // gm.stop()    — removes the container
 *
 * Blueprint ref: ENV-X-009 (tests never run against a cluster database —
 * same principle applies to IMAP: use ephemeral containers on random ports).
 *
 * Superfield-distribution reference: packages/db/imap-container.ts
 */

import { addProcess, removeProcess } from './cleanup';

const GREENMAIL_IMAGE = 'greenmail/standalone:2.1.3';
const GREENMAIL_USER = 'test@localhost.com';
const GREENMAIL_PASSWORD = 'test123';
const READY_TIMEOUT_MS = 60_000;
const PORT_POLL_INTERVAL_MS = 300;

export interface GreenmailContainer {
  /** Mapped IMAP port on localhost (plain/STARTTLS). */
  imapPort: number;
  /** Mapped IMAPS port on localhost (TLS). */
  imapsPort: number;
  /** Mapped SMTP port on localhost. */
  smtpPort: number;
  /** IMAP/SMTP username. */
  user: string;
  /** IMAP/SMTP password. */
  password: string;
  /** The running container ID. */
  containerId: string;
  /**
   * Inject a test email into the test mailbox via the SMTP port.
   *
   * Uses Bun's built-in TCP socket to send a minimal raw SMTP conversation.
   * No additional SMTP library dependency is required.
   */
  sendMail: (subject: string, body: string) => Promise<void>;
  /** Stop and remove the container. */
  stop: () => Promise<void>;
}

/**
 * Start a Greenmail container on random ports and wait until IMAP is ready.
 *
 * @returns A `GreenmailContainer` handle with port mappings and helpers.
 */
export async function startGreenmail(): Promise<GreenmailContainer> {
  const runResult = Bun.spawnSync([
    'docker',
    'run',
    '-d',
    '--rm',
    '-p',
    '0:3143', // IMAP STARTTLS
    '-p',
    '0:3993', // IMAPS
    '-p',
    '0:3025', // SMTP
    '-e',
    `GREENMAIL_OPTS=-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled=false -Dgreenmail.users=${GREENMAIL_USER}:${GREENMAIL_PASSWORD}`,
    GREENMAIL_IMAGE,
  ]);

  if (runResult.exitCode !== 0) {
    throw new Error(
      `Failed to start Greenmail container: ${new TextDecoder().decode(runResult.stderr)}`,
    );
  }

  const containerId = new TextDecoder().decode(runResult.stdout).trim();
  addProcess(containerId, 'greenmail');

  let imapPort: number;
  let imapsPort: number;
  let smtpPort: number;

  try {
    [imapPort, imapsPort, smtpPort] = await Promise.all([
      getContainerPortWithRetry(containerId, 3143),
      getContainerPortWithRetry(containerId, 3993),
      getContainerPortWithRetry(containerId, 3025),
    ]);

    await waitForImap(imapPort);
  } catch (err) {
    removeProcess(containerId);
    Bun.spawnSync(['docker', 'stop', containerId]);
    throw err;
  }

  const stop = async (): Promise<void> => {
    removeProcess(containerId);
    Bun.spawnSync(['docker', 'stop', containerId]);
  };

  const sendMail = async (subject: string, body: string): Promise<void> => {
    await sendSmtpViaCurl(smtpPort, GREENMAIL_USER, subject, body);
  };

  return {
    imapPort,
    imapsPort,
    smtpPort,
    user: GREENMAIL_USER,
    password: GREENMAIL_PASSWORD,
    containerId,
    sendMail,
    stop,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getContainerPortWithRetry(
  containerId: string,
  containerPort: number,
): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = Bun.spawnSync(['docker', 'port', containerId, String(containerPort)]);
    const output = new TextDecoder().decode(result.stdout).trim();
    try {
      return parseDockerPortOutput(output);
    } catch {
      await Bun.sleep(PORT_POLL_INTERVAL_MS);
    }
  }
  throw new Error(
    `Timed out waiting for docker to publish port ${containerPort} for container ${containerId}`,
  );
}

async function waitForImap(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await probeImapPort(port);
      return;
    } catch {
      await Bun.sleep(PORT_POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Greenmail IMAP did not become ready within ${READY_TIMEOUT_MS}ms`);
}

/**
 * Probe the IMAP port by opening a TCP connection and reading the greeting.
 * Greenmail emits "* OK Greenmail IMAP4 Service ready" when ready.
 */
async function probeImapPort(port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('IMAP probe timed out'));
    }, 2000);

    const socket = Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(_socket, data) {
          const banner = data.toString();
          clearTimeout(timeout);
          if (banner.includes('OK')) {
            _socket.end();
            resolve();
          } else {
            reject(new Error(`Unexpected IMAP banner: ${banner.slice(0, 100)}`));
          }
        },
        error(_socket, err) {
          clearTimeout(timeout);
          reject(err);
        },
        connectError(_socket, err) {
          clearTimeout(timeout);
          reject(err);
        },
        open() {},
        close() {},
        drain() {},
      },
    });

    void socket.catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Send a test email to Greenmail via curl SMTP.
 *
 * curl is available in all CI and dev environments and handles the SMTP
 * protocol reliably without requiring an additional Node.js SMTP library.
 * Greenmail accepts unauthenticated SMTP from localhost by default.
 */
async function sendSmtpViaCurl(
  smtpPort: number,
  recipient: string,
  subject: string,
  body: string,
): Promise<void> {
  const fromAddr = 'sender@localhost.com';
  const crlf = '\r\n';

  const rawMessage =
    `From: ${fromAddr}${crlf}` +
    `To: ${recipient}${crlf}` +
    `Subject: ${subject}${crlf}` +
    `Date: ${new Date().toUTCString()}${crlf}` +
    `${crlf}` +
    `${body}${crlf}`;

  const proc = Bun.spawn(
    [
      'curl',
      '--silent',
      '--url',
      `smtp://127.0.0.1:${smtpPort}`,
      '--mail-from',
      fromAddr,
      '--mail-rcpt',
      recipient,
      '--upload-file',
      '-',
    ],
    {
      stdin: new TextEncoder().encode(rawMessage),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`curl SMTP failed (exit ${exitCode}): ${stderr.slice(0, 200)}`);
  }
}

export function parseDockerPortOutput(output: string): number {
  if (!output.trim()) {
    throw new Error('Could not parse port from docker port output: ""');
  }
  const firstLine = output.split('\n')[0].trim();
  const port = parseInt(firstLine.split(':').at(-1) ?? '', 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Could not parse port from docker port output: "${output}"`);
  }
  return port;
}
