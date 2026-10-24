import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { BRAND } from '@ddd/shared';
import { api } from '../api';
import { useResource, useTheme } from '../hooks';
import { timeAgo } from '../format';
import { Icon } from './Icons';

function Brand() {
  return (
    <NavLink to="/projects" className="brand" aria-label="GateX projects">
      <span className="brand-mark">
        <Icon name="cpu" size={18} strokeWidth={2.2} />
      </span>
      <span className="brand-text">
        <span className="brand-name-row">
          <span className="brand-name">{BRAND.name}</span>
          <span className="brand-badge">AI</span>
        </span>
        <span className="brand-sub">{BRAND.tagline}</span>
      </span>
    </NavLink>
  );
}

function Sidebar() {
  const { pathname } = useLocation();
  const projects = useResource(api.projects, [pathname]);
  const config = useResource(api.config, []);
  const [theme, toggleTheme] = useTheme();

  return (
    <aside className="sidebar">
      <Brand />
      <nav className="nav" aria-label="Main">
        <NavLink to="/new" className="btn btn-primary nav-cta">
          <Icon name="plus" /> New check
        </NavLink>
        <NavLink to="/projects" end className="nav-link">
          <Icon name="folder" /> Projects
        </NavLink>
        <NavLink to="/import-scorecard" className="nav-link">
          <Icon name="sheet" /> Convert a scorecard
        </NavLink>
        <NavLink to="/library" className="nav-link">
          <Icon name="check" /> Test library
        </NavLink>
        <NavLink to="/models" className="nav-link">
          <Icon name="cpu" /> Examiners
        </NavLink>
      </nav>

      <div className="side-section">
        <div className="side-title">Recent</div>
        <div className="side-list">
          {(projects.data ?? []).slice(0, 7).map((p) => (
            <NavLink key={p.id} to={`/projects/${p.id}`} className="side-item">
              <span className={`dot dot-${p.latest?.finalDecision ?? 'none'}`} />
              <span className="side-item-name">{p.name}</span>
              <span className="side-item-meta">{timeAgo(p.latest?.createdAt)}</span>
            </NavLink>
          ))}
          {projects.data?.length === 0 && <p className="side-empty">Nothing checked yet.</p>}
        </div>
      </div>

      <div className="side-foot">
        {config.data && (
          <div className={`mode ${config.data.mock ? 'mode-mock' : config.data.ready ? 'mode-live' : 'mode-warn'}`}>
            <span className="dot" />
            {config.data.mock ? 'Demo mode' : config.data.ready ? 'Examiners ready' : 'Examiners need setup'}
          </div>
        )}
        <button type="button" className="btn btn-ghost btn-sm theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={15} /> {theme === 'light' ? 'Dark theme' : 'Light theme'}
        </button>
        <p className="side-note">GateX advises. You make the final call.</p>
      </div>
    </aside>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <Sidebar />
      <main className="main">
        <div className="main-inner">
          {/* Keyed by the address, so each page animates in when you navigate to it. */}
          <div key={pathname} className="page">
            <Outlet />
          </div>
        </div>
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  eyebrow,
  actions,
  children,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-main">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {children && <div className="page-sub">{children}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  aside,
  children,
  id,
  className = '',
  flush = false,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section id={id} className={`card ${className}`}>
      {(title || aside) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {aside && <div className="card-aside">{aside}</div>}
        </div>
      )}
      <div className={flush ? 'card-body card-flush' : 'card-body'}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon, title, children, action }: { icon: Parameters<typeof Icon>[0]['name']; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner banner-red" role="alert">
      <Icon name="alert" />
      <span>{message}</span>
      {onRetry && (
        <button className="btn btn-ghost btn-sm" onClick={onRetry}>
          <Icon name="refresh" size={14} /> Retry
        </button>
      )}
    </div>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="loading-label">
        <span className="spinner" />
        {label}…
      </div>
      <div className="skeleton-row" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton skeleton-stat" />
        ))}
      </div>
      <div className="skeleton skeleton-card" aria-hidden="true" />
    </div>
  );
}
