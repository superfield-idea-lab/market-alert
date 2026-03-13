import { describe, expect, test } from 'vitest';
import { buildTaskConsequentialWriteRequest } from '../../src/policies/task-write-service';

describe('buildTaskConsequentialWriteRequest', () => {
  test('captures principal, executor, and patch payload for task updates', () => {
    const request = buildTaskConsequentialWriteRequest({
      taskId: 'task-123',
      current: {
        name: 'Existing task',
        description: '',
        owner: 'alice',
        priority: 'medium',
        status: 'todo',
        estimateStart: null,
        estimatedDeliver: null,
        dependsOn: [],
        tags: [],
      },
      patch: {
        status: 'in_progress',
        owner: 'bob',
      },
      principal: {
        id: 'user-1',
        kind: 'human',
      },
      reason: 'task.patch',
    });

    expect(request.transactionType).toBe('task.update');
    expect(request.principal).toEqual({
      id: 'user-1',
      kind: 'human',
    });
    expect(request.executor).toEqual({
      id: 'user-1',
      kind: 'human',
    });
    expect(request.authorityContext).toEqual({
      reason: 'task.patch',
    });
    expect(request.payload).toEqual({
      taskId: 'task-123',
      current: {
        name: 'Existing task',
        description: '',
        owner: 'alice',
        priority: 'medium',
        status: 'todo',
        estimateStart: null,
        estimatedDeliver: null,
        dependsOn: [],
        tags: [],
      },
      patch: {
        status: 'in_progress',
        owner: 'bob',
      },
      next: {
        name: 'Existing task',
        description: '',
        owner: 'bob',
        priority: 'medium',
        status: 'in_progress',
        estimateStart: null,
        estimatedDeliver: null,
        dependsOn: [],
        tags: [],
      },
    });
  });
});
