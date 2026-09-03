import { describe, expect, it } from 'vitest';
import { projectPath, projectSwitchPath } from '@/components/admin/project-path';

describe('projectPath', () => {
  it('builds an explicit project route', () => {
    expect(projectPath('project-a', 'keys')).toBe('/admin/p/project-a/keys');
  });
});

describe('projectSwitchPath', () => {
  it('keeps a top-level surface without carrying project-local resource ids', () => {
    expect(
      projectSwitchPath('/admin/p/project-a/logs/log-a', 'project-a', 'project-b', 'admin'),
    ).toBe('/admin/p/project-b/logs');
  });

  it('falls back to overview when an editor switches from an admin-only surface', () => {
    expect(
      projectSwitchPath('/admin/p/project-a/settings', 'project-a', 'project-b', 'editor'),
    ).toBe('/admin/p/project-b');
  });

  it('keeps the knowledgebase surface when an editor switches projects', () => {
    expect(
      projectSwitchPath(
        '/admin/p/project-a/knowledgebases',
        'project-a',
        'project-b',
        'editor',
      ),
    ).toBe('/admin/p/project-b/knowledgebases');
  });

  it('does not change the user default as part of route switching', () => {
    expect(projectSwitchPath('/admin/p/project-a/usage', 'project-a', 'project-b', 'admin')).toBe(
      '/admin/p/project-b/usage',
    );
  });
});
