import { describe, expect, test } from 'vitest';
import {
  buildDemoPlan,
  buildDemoSecretManifests,
  demoConfig,
  describeCommandFailure,
  describeProbeFailure,
} from '../../scripts/demo';

describe('demo runtime contract', () => {
  test('plans the cluster bootstrap, image rollout, and interactive refresh loop', () => {
    const plan = buildDemoPlan(demoConfig({ interactive: true, port: 58080 }));

    expect(plan.map((step) => step.name)).toEqual([
      'cluster bootstrap',
      'database bootstrap',
      'image build',
      'image import',
      'manifest apply',
      'rollout',
      'watch prompt loop',
    ]);

    expect(plan[0]?.commands?.[0]).toContain('k3d cluster create superfield-demo');
    expect(plan[2]?.commands?.[0]).toContain('docker build -f Dockerfile.release');
    expect(plan[5]?.commands?.[0]).toContain('kubectl rollout status deployment/superfield-app');
  });

  test('supports overriding the host database port for cluster bootstrap', () => {
    const plan = buildDemoPlan(demoConfig({ interactive: false, port: 58080, dbPort: 55432 }));

    expect(plan[0]?.commands?.[0]).toContain('--port 55432:5432@loadbalancer');
    expect(plan[1]?.commands?.[3]).toContain('localhost:55432');
  });

  test('generates demo secrets that target the local k3d postgres service', () => {
    const manifests = buildDemoSecretManifests(demoConfig({ interactive: false, port: 58080 }));

    expect(manifests).toContain('name: superfield-secrets');
    expect(manifests).toContain('name: superfield-api-secrets');
    expect(manifests).toContain('superfield-dev-postgres');
    expect(manifests).toContain(
      'postgres://app_rw:app_rw_password@superfield-dev-postgres:5432/superfield_app',
    );
    expect(manifests).toContain(
      'postgres://audit_w:audit_w_password@superfield-dev-postgres:5432/superfield_audit',
    );
    expect(manifests).toContain(
      'postgres://analytics_w:analytics_w_password@superfield-dev-postgres:5432/superfield_analytics',
    );
  });

  test('formats cluster bootstrap port conflicts with actionable guidance', () => {
    const message = describeCommandFailure(
      'cluster bootstrap',
      ['k3d', 'cluster', 'create', 'superfield-demo', '--port', '5432:5432@loadbalancer', '--wait'],
      'failed to bind host port 0.0.0.0:5432/tcp: address already in use',
    );

    expect(message).toContain('cluster bootstrap failed');
    expect(message).toContain('Host port 5432 is already in use');
    expect(message).toContain('k3d cluster create superfield-demo');
  });

  test('formats deploy failures with stderr context', () => {
    const message = describeCommandFailure(
      'deploy',
      ['kubectl', 'rollout', 'status', 'deployment/superfield-app', '--timeout=180s'],
      'deployment "superfield-app" exceeded its progress deadline',
    );

    expect(message).toContain('deploy failed');
    expect(message).toContain('deployment "superfield-app" exceeded its progress deadline');
  });

  test('formats health probe failures with the target URL', () => {
    const message = describeProbeFailure(
      'deploy readiness',
      'http://127.0.0.1:58080/health/live',
      new Error('HTTP 503'),
    );

    expect(message).toContain('deploy readiness failed');
    expect(message).toContain('http://127.0.0.1:58080/health/live');
    expect(message).toContain('HTTP 503');
  });
});
