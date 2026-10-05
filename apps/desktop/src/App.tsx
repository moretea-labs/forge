import { useMemo, useState } from 'react';
import { disconnectedProjection } from './runtime-projection';

const PRIMARY_NAV = ['New Thread', 'Search', 'Projects', 'Recent Threads'] as const;
const OPERATIONS_NAV = ['Activity', 'Schedules', 'Needs You'] as const;
const SYSTEM_NAV = ['Connections', 'Plugins', 'Instances', 'Settings'] as const;
const INSPECTOR_TABS = ['Goal', 'Plan', 'Changes', 'Evidence', 'Resources'] as const;

type NavItem = (typeof PRIMARY_NAV)[number] | (typeof OPERATIONS_NAV)[number] | (typeof SYSTEM_NAV)[number];

function NavGroup({ items, active, onSelect }: { items: readonly NavItem[]; active: NavItem; onSelect: (item: NavItem) => void }) {
  return (
    <div className="nav-group">
      {items.map((item) => (
        <button key={item} className={item === active ? 'nav-item active' : 'nav-item'} onClick={() => onSelect(item)} type="button">
          <span>{item}</span>
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [activeNav, setActiveNav] = useState<NavItem>('New Thread');
  const [activeInspector, setActiveInspector] = useState<(typeof INSPECTOR_TABS)[number]>('Goal');
  const [draft, setDraft] = useState('');
  const projection = disconnectedProjection;
  const runtimeTone = useMemo(() => `runtime-pill ${projection.runtime.status}`, [projection.runtime.status]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark">F</div>
          <div>
            <div className="brand-name">Forge</div>
            <div className="brand-subtitle">V3 Desktop</div>
          </div>
        </div>
        <NavGroup items={PRIMARY_NAV} active={activeNav} onSelect={setActiveNav} />
        <div className="nav-label">Operations</div>
        <NavGroup items={OPERATIONS_NAV} active={activeNav} onSelect={setActiveNav} />
        <div className="nav-label">System</div>
        <NavGroup items={SYSTEM_NAV} active={activeNav} onSelect={setActiveNav} />
        <div className="sidebar-footer">
          <span className={runtimeTone} aria-hidden="true" />
          <div>
            <div className="runtime-label">{projection.runtime.label}</div>
            <div className="runtime-detail">Single Runtime authority</div>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <div className="eyebrow">{activeNav}</div>
            <h1>Start a conversation</h1>
          </div>
          <div className="header-runtime">{projection.runtime.label}</div>
        </header>

        <section className="conversation-panel">
          <div className="empty-state">
            <div className="empty-kicker">Conversation first</div>
            <h2>What do you want Forge to work on?</h2>
            <p>
              Threads are interaction surfaces. Goal, Plan and Work remain canonical Runtime facts and can continue across conversations.
            </p>
          </div>

          <div className="composer-wrap">
            <textarea
              aria-label="Message Forge"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Ask Forge to inspect, change, verify, or continue work…"
              rows={4}
            />
            <div className="composer-footer">
              <span>Runtime connection lands in the next slice.</span>
              <button type="button" disabled={!draft.trim()} title="Runtime transport is not connected yet">
                Send
              </button>
            </div>
          </div>
        </section>
      </section>

      <aside className="inspector">
        <div className="inspector-tabs" role="tablist" aria-label="Thread inspector">
          {INSPECTOR_TABS.map((tab) => (
            <button
              key={tab}
              className={tab === activeInspector ? 'inspector-tab active' : 'inspector-tab'}
              onClick={() => setActiveInspector(tab)}
              role="tab"
              aria-selected={tab === activeInspector}
              type="button"
            >
              {tab}
            </button>
          ))}
        </div>
        <div className="inspector-body">
          <div className="inspector-card">
            <div className="card-label">{activeInspector}</div>
            <h3>No Runtime projection yet</h3>
            <p>{projection.runtime.detail}</p>
          </div>
          <div className="authority-note">
            <strong>Projection only</strong>
            <span>This client does not persist Requirement, Plan, Work, Controller, Schedule, or connection truth.</span>
          </div>
        </div>
      </aside>
    </main>
  );
}
