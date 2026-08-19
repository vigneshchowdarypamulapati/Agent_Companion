import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ProjectPicker, { type ProjectListEntry } from './ProjectPicker';

const projects: ProjectListEntry[] = [
  { path: '/home/me/companion', displayName: 'companion', source: 'history', lastUsedAt: 2000 },
  { path: '/home/me/old-project', displayName: 'old-project', source: 'history', lastUsedAt: 1000 },
  { path: '/home/me/root/fresh-clone', displayName: 'fresh-clone', source: 'configured', lastUsedAt: undefined },
];

describe('ProjectPicker', () => {
  it('renders every project, most-recently-used first, as already sorted by the caller', () => {
    render(<ProjectPicker projects={projects} onSelect={vi.fn()} />);
    const items = screen.getAllByRole('button', { name: /companion|old-project|fresh-clone/ });
    expect(items.map((el) => el.textContent)).toEqual([
      expect.stringContaining('companion'),
      expect.stringContaining('old-project'),
      expect.stringContaining('fresh-clone'),
    ]);
  });

  it('shows a "first time" badge only on configured-source entries with no history', () => {
    render(<ProjectPicker projects={projects} onSelect={vi.fn()} />);
    const freshRow = screen.getByRole('button', { name: /fresh-clone/ });
    expect(freshRow).toHaveTextContent(/first time/i);
    const knownRow = screen.getByRole('button', { name: /^companion/ });
    expect(knownRow).not.toHaveTextContent(/first time/i);
  });

  it('filters as you type, matching displayName case-insensitively', async () => {
    render(<ProjectPicker projects={projects} onSelect={vi.fn()} />);
    await userEvent.type(screen.getByRole('searchbox'), 'FRESH');
    expect(screen.queryByRole('button', { name: /^companion/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /fresh-clone/ })).toBeInTheDocument();
  });

  it('calls onSelect with the chosen project when tapped', async () => {
    const onSelect = vi.fn();
    render(<ProjectPicker projects={projects} onSelect={onSelect} />);
    await userEvent.click(screen.getByRole('button', { name: /^companion/ }));
    expect(onSelect).toHaveBeenCalledWith(projects[0]);
  });

  it('shows an empty state when there are no projects at all', () => {
    render(<ProjectPicker projects={[]} onSelect={vi.fn()} />);
    expect(screen.getByText(/no projects yet/i)).toBeInTheDocument();
  });
});
