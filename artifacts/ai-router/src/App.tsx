import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from 'wouter';
import {
  Activity, AlertCircle, ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Code2, Copy,
  Cpu, Eye, EyeOff, Gauge, KeyRound, Layers3, LockKeyhole, LogOut, Menu, MessageSquareText,
  Network, Plus, RefreshCw, Server, ShieldCheck, Sparkles, Trash2, X, Zap,
} from 'lucide-react';
import {
  getGetRouterDashboardQueryKey, getListProvidersQueryKey, getListRouterKeysQueryKey,
  getListRouterRequestsQueryKey, useCreateChatCompletion, useCreateProvider, useCreateRouterKey,
  useDeleteProvider, useGetRouterDashboard, useHealthCheck, useListProviders,
  useListRouterKeys, useListRouterRequests, usePreviewProviderModels,
  useRefreshProviderModels, useRevokeRouterKey, useTestRouterCompletion,
  setAuthTokenGetter,
} from '@workspace/api-client-react';
import type { Provider, ProviderInputApiProtocol, ProviderInputKind, ProviderModelPreview, RouterKey } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
if (typeof localStorage !== 'undefined') {
  setAuthTokenGetter(() => localStorage.getItem('air_access_token'));
}

type RuntimeConfig = {
  authDisabled?: boolean;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
};

function useRuntimeConfig(): RuntimeConfig | null {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`${basePath}/api/config`)
      .then((response) => {
        if (!response.ok) throw new Error('config unavailable');
        return response.json() as Promise<RuntimeConfig>;
      })
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch(() => {
        if (!cancelled) setConfig({});
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

type AuthUser = { id: string; email?: string };
type AuthState = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

function AuthProvider({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem('air_access_token'));
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const authHeaders = (token?: string | null) => ({
    apikey: config.supabasePublishableKey ?? '',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  });

  useEffect(() => {
    if (config.authDisabled) {
      setUser({ id: 'local', email: 'local@router' });
      setLoading(false);
      return;
    }
    if (!accessToken) {
      setUser(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: authHeaders(accessToken) })
      .then((response) => {
        if (!response.ok) throw new Error('unauthorized');
        return response.json() as Promise<AuthUser>;
      })
      .then((value) => {
        if (!cancelled) setUser(value);
      })
      .catch(() => {
        if (!cancelled) {
          localStorage.removeItem('air_access_token');
          setAccessToken(null);
          setUser(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken, config.supabaseUrl, config.supabasePublishableKey]);

  const signIn = async (email: string, password: string) => {
    if (config.authDisabled) return;
    const loginEmail = email.includes('@') ? email : `${email}@router.local`;
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, password }),
    });
    if (!response.ok) throw new Error('Неверный email или пароль');
    const data = await response.json() as { access_token: string; user: AuthUser };
    localStorage.setItem('air_access_token', data.access_token);
    setAccessToken(data.access_token);
    setUser(data.user);
  };

  const signUp = async (email: string, password: string) => {
    if (config.authDisabled) return;
    const loginEmail = email.includes('@') ? email : `${email}@router.local`;
    const response = await fetch(`${config.supabaseUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, password }),
    });
    if (!response.ok) throw new Error('Не удалось создать аккаунт');
    const data = await response.json() as { access_token?: string; user?: AuthUser };
    if (!data.access_token) {
      throw new Error('Подтвердите email, отправленный Supabase, затем войдите');
    }
    localStorage.setItem('air_access_token', data.access_token);
    setAccessToken(data.access_token);
    setUser(data.user ?? null);
  };

  const signOut = async () => {
    if (config.authDisabled) return;
    try {
      await fetch(`${config.supabaseUrl}/auth/v1/logout`, {
        method: 'POST',
        headers: authHeaders(accessToken),
      });
    } catch {
      // Ignore network errors: the local session is removed regardless.
    }
    localStorage.removeItem('air_access_token');
    setAccessToken(null);
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>{children}</AuthContext.Provider>;
}

function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('AuthProvider is missing');
  return context;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand" data-testid="brand-ai-router">
    <span className="brand-mark"><Network size={19} strokeWidth={2.3} /></span>
    {!compact && <span><span className="brand-name">NVIDIA AI Router</span><span className="brand-sub">Private control room</span></span>}
  </div>;
}

function QueryClientCacheInvalidator() {
  const { user } = useAuth();
  const client = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const userId = user?.id ?? null;
    if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) client.clear();
    prevUserIdRef.current = userId;
  }, [user?.id, client]);
  return null;
}

function MissingAuthConfig() {
  return <main className="min-h-screen flex items-center justify-center bg-[#fbfaf4] p-6">
    <section className="max-w-xl w-full rounded-2xl border border-[#dcded3] bg-white p-8">
      <div className="brand" style={{ marginBottom: 18 }}><span className="brand-mark"><Network size={19} strokeWidth={2.3} /></span><span><span className="brand-name">NVIDIA AI Router</span><span className="brand-sub">Private control room</span></span></div>
      <h1 className="text-2xl font-bold text-[#203c31]">Supabase is not configured</h1>
      <p className="mt-3 text-sm text-[#526156]">Set <code className="mono">SUPABASE_URL</code> and <code className="mono">SUPABASE_PUBLISHABLE_KEY</code> in the environment and restart the service. See <code className="mono">README.md</code>.</p>
    </section>
  </main>;
}

function AppRoutes() {
  return <>
    <QueryClientCacheInvalidator />
    <Switch>
      <Route path="/" component={HomeRedirect} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/dashboard" component={ProtectedDashboard} />
      <Route path="/providers/new" component={ProtectedProviderConnect} />
      <Route path="/providers" component={ProtectedProviders} />
      <Route path="/keys" component={ProtectedKeys} />
      <Route path="/playground" component={ProtectedPlayground} />
      <Route component={NotFound} />
    </Switch>
  </>;
}

function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const { signIn, signUp } = useAuth();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'sign-in') await signIn(email, password);
      else await signUp(email, password);
      setLocation('/dashboard');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  return <form className="w-full max-w-[380px]" onSubmit={submit} noValidate>
    <h2 className="text-2xl font-bold text-[#203c31] mb-1">{mode === 'sign-in' ? 'Welcome back' : 'Create your workspace'}</h2>
    <p className="text-sm text-[#778078] mb-6">{mode === 'sign-in' ? 'Sign in to your private model control room.' : 'One clear view of every model connection.'}</p>
    <div className="field"><label htmlFor="auth-email">Login / Email</label><input id="auth-email" type="text" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="KLABOK or you@example.com" /></div>
    <div className="field" style={{ marginTop: 14 }}><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 6 characters" /></div>
    {error && <div className="notice-error" role="alert" style={{ marginTop: 14 }}>{error}</div>}
    <button type="submit" className="button button-primary" disabled={busy} style={{ marginTop: 18, width: '100%' }}>{busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}</button>
    <p className="field-hint" style={{ marginTop: 16, textAlign: 'center' }}>
      {mode === 'sign-in' ? <>No account? <Link href="/sign-up">Create one</Link></> : <>Already have an account? <Link href="/sign-in">Sign in</Link></>}
    </p>
  </form>;
}

function SignInPage() {
  return <div className="auth-page">
    <div className="auth-backdrop"><div className="auth-brand"><Brand /></div><div className="auth-copy"><span>ONE KEY. EVERY MODEL.</span><h1>Your models,<br />on your terms.</h1><p>Connect the providers you trust. Route calls through one revocable key. Keep your upstream credentials server-side.</p></div><div className="auth-legal">PRIVATE BY DESIGN <span>•</span> OPENAI-COMPATIBLE</div></div>
    <div className="auth-form-wrap"><AuthForm mode="sign-in" /></div>
  </div>;
}

function SignUpPage() {
  return <div className="auth-page">
    <div className="auth-backdrop"><div className="auth-brand"><Brand /></div><div className="auth-copy"><span>YOUR PRIVATE AI CONTROL ROOM</span><h1>Bring your<br />own intelligence.</h1><p>Connect NVIDIA NIM, OpenRouter, DeepSeek, OpenAI, or any OpenAI-compatible endpoint.</p></div><div className="auth-legal">YOUR ACCOUNTS. YOUR KEYS. YOUR CONTROL.</div></div>
    <div className="auth-form-wrap"><AuthForm mode="sign-up" /></div>
  </div>;
}

function HomeRedirect() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingConfig />;
  return user ? <Redirect to="/dashboard" /> : <Landing />;
}

function Landing() {
  return <main className="landing">
    <nav className="landing-nav">
      <Link href="/" className="landing-brand"><Brand /></Link>
      <div className="landing-links"><a href="#how-it-works">How it works</a><a href="#privacy">Privacy</a><Link href="/sign-in" className="button button-outline">Sign in</Link><Link href="/sign-up" className="button button-primary">Create workspace <ArrowRight size={14} /></Link></div>
    </nav>
    <section className="landing-hero">
      <div>
        <div className="landing-kicker"><span className="pulse" /> PRIVATE MODEL ROUTING</div>
        <h1>One route.<br /><em>Your choice</em><br />of intelligence.</h1>
        <p>Connect the AI providers you already use. Discover their models. Call them through one OpenAI-compatible endpoint—with your provider credentials kept server-side.</p>
        <div className="hero-actions"><Link href="/sign-up" className="button button-primary">Set up your router <ArrowRight size={15} /></Link><Link href="/sign-in" className="button button-outline">I have an account</Link></div>
        <div className="hero-footnote">API keys come from your own provider accounts. Nothing is shared with Replit.</div>
      </div>
      <div className="hero-art" aria-label="Provider routing illustration">
        <div className="orbit" /><div className="orbit two" />
        <div className="orbit-node n1"><Cpu size={21} /></div><div className="orbit-node n2"><Layers3 size={21} /></div><div className="orbit-node n3"><Zap size={21} /></div><div className="orbit-node n4"><Server size={21} /></div>
        <div className="core-node"><Network size={44} strokeWidth={1.5} /></div>
        <span className="art-label">provider mesh / private by design</span>
      </div>
    </section>
    <section className="landing-section" id="how-it-works">
      <div className="section-heading"><h2>A shorter path<br />from key to call.</h2><p>Keep provider setup legible, credentials contained, and model access in one place.</p></div>
      <div className="steps">
        <article className="step-card"><div className="step-no">01 / CONNECT</div><h3>Bring your provider account</h3><p>Connect NVIDIA NIM, OpenRouter, DeepSeek, OpenAI, or your own HTTPS endpoint.</p></article>
        <article className="step-card"><div className="step-no">02 / DISCOVER</div><h3>See what is available</h3><p>Refresh a connection to discover the models your upstream key can access.</p></article>
        <article className="step-card"><div className="step-no">03 / ROUTE</div><h3>Use one revocable key</h3><p>Choose a model and send standard OpenAI-compatible requests through the router.</p></article>
      </div>
    </section>
    <section className="landing-security" id="privacy">
      <div><div className="landing-kicker" style={{ color: '#b7dcb0' }}><ShieldCheck size={14} /> CREDENTIAL BOUNDARY</div><h2>Your upstream keys stay on the server.</h2><p>Provider credentials are sent directly to the router to establish each connection. They are never shown again in this browser experience.</p></div>
      <div className="security-list"><div className="security-point"><strong>Provider keys stay protected</strong>Only masked hints appear after connection.</div><div className="security-point"><strong>Router keys are yours</strong>Create one-time-visible keys and revoke them whenever you need.</div><div className="security-point"><strong>Use your own accounts</strong>Provider API keys come from your own provider subscriptions.</div><div className="security-point"><strong>Standard request shape</strong>Keep your existing OpenAI-compatible client workflow.</div></div>
    </section>
    <footer className="landing-footer"><span>NVIDIA AI Router · Private model control room</span><span>Use the providers you already trust.</span></footer>
  </main>;
}

function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <LoadingConfig />;
  return user ? <>{children}</> : <Redirect to="/" />;
}
function ProtectedDashboard() { return <Protected><AppShell><Dashboard /></AppShell></Protected>; }
function ProtectedProviders() { return <Protected><AppShell><ProvidersPage /></AppShell></Protected>; }
function ProtectedProviderConnect() { return <Protected><AppShell><AddProviderPage /></AppShell></Protected>; }
function ProtectedKeys() { return <Protected><AppShell><KeysPage /></AppShell></Protected>; }
function ProtectedPlayground() { return <Protected><AppShell><PlaygroundPage /></AppShell></Protected>; }

const navLinks = [
  { href: '/dashboard', label: 'Overview', icon: Gauge },
  { href: '/providers', label: 'Providers & models', icon: Layers3 },
  { href: '/keys', label: 'Router keys', icon: KeyRound },
  { href: '/playground', label: 'Playground', icon: Code2 },
];

function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, signOut } = useAuth();
  const health = useHealthCheck();
  const title = navLinks.find((entry) => entry.href === location || (entry.href === '/providers' && location.startsWith('/providers/')))?.label ?? 'Overview';
  const initials = user?.email ? user.email.slice(0, 2).toUpperCase() : 'AI';
  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
      <Link href="/dashboard" onClick={() => setMobileOpen(false)}><Brand /></Link>
      <div className="nav-label">Control room</div>
      {navLinks.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMobileOpen(false)} className={`nav-item ${location === href || (href === '/providers' && location.startsWith('/providers/')) ? 'active' : ''}`} data-testid={`link-nav-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} strokeWidth={1.8} />{label}</Link>)}
      <div className="sidebar-bottom">
        <div className="secure-note"><strong><LockKeyhole size={14} /> Credentials stay upstream</strong>Only masked key hints are shown here. Provider secrets are never displayed again.</div>
        <div className="profile-row"><span className="profile-avatar">{initials}</span><span className="profile-label">{user?.email || 'Your workspace'}<small>Private workspace</small></span><button className="icon-btn" aria-label="Sign out" data-testid="button-sign-out" onClick={() => { void signOut(); }}><LogOut size={16} color="#a8bdb1" /></button></div>
      </div>
    </aside>
    <div className="main-area">
      <header className="topbar">
        <div className="crumb"><button className="icon-btn mobile-menu" aria-label="Open navigation" onClick={() => setMobileOpen(!mobileOpen)} data-testid="button-mobile-menu"><Menu size={19} /></button><span>Workspace</span><span>/</span><strong style={{ color: '#43594b' }}>{title}</strong></div>
        <div className="top-right"><div className="system-pill" data-testid="status-service"><span className="pulse" style={{ background: health.isError ? '#ce7166' : undefined }} />{health.isLoading ? 'Checking service' : health.isError ? 'Service status unavailable' : 'Router operational'}</div></div>
      </header>
      {children}
    </div>
  </div>;
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1 className="page-title">{title}</h1><p className="page-desc">{description}</p></div>{action}</div>;
}
function LoadingBlock({ label = 'Loading your router data' }: { label?: string }) {
  return <div className="surface empty" aria-live="polite"><div className="empty-mark"><Activity size={21} /></div><h3>{label}</h3><p>Getting the latest status from your private router.</p><div className="skeleton-line" /></div>;
}
function QueryError({ retry, message = 'We could not load this information right now.' }: { retry: () => void; message?: string }) {
  return <div className="surface empty"><div className="empty-mark" style={{ background: '#fff0ed', color: '#a94c40' }}><AlertCircle size={21} /></div><h3>Something did not load</h3><p>{message}</p><button className="button button-outline" onClick={retry} data-testid="button-retry"><RefreshCw size={14} /> Try again</button></div>;
}
function EmptyState({ icon: Icon = Layers3, title, text, action }: { icon?: typeof Layers3; title: string; text: string; action?: ReactNode }) {
  return <div className="empty"><div className="empty-mark"><Icon size={21} /></div><h3>{title}</h3><p>{text}</p>{action}</div>;
}
function formatDate(value?: string | null) {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return 'The request could not be completed. Check the connection and try again.';
}
function invalidateProviderData(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: getListProvidersQueryKey() });
  void client.invalidateQueries({ queryKey: getGetRouterDashboardQueryKey() });
}

function Dashboard() {
  const dashboard = useGetRouterDashboard();
  const providers = useListProviders();
  const requests = useListRouterRequests({ limit: 8 });
  const loading = dashboard.isLoading || providers.isLoading || requests.isLoading;
  if (loading) return <main className="page"><LoadingBlock /></main>;
  if (dashboard.isError || providers.isError || requests.isError) return <main className="page"><QueryError retry={() => { void dashboard.refetch(); void providers.refetch(); void requests.refetch(); }} /></main>;
  const data = dashboard.data;
  const providerItems = providers.data ?? [];
  const recent = requests.data ?? data?.recentRequests ?? [];
  return <main className="page">
    <PageHeader eyebrow="Control room / overview" title="Your router, at a glance." description="A live view of connected providers, discovered models, keys, and recent routed requests." action={<Link href="/providers" className="button button-outline"><Layers3 size={15} /> Manage providers</Link>} />
    {!providerItems.length && <section className="setup-banner"><div><h2>Start with a provider connection.</h2><p>Connect your own provider account to discover models and send your first routed request. Your upstream key is only sent to the server.</p></div><Link href="/providers/new" className="button" data-testid="button-setup-provider"><Plus size={15} /> Connect a provider</Link></section>}
    <div className="stat-grid">
      <StatCard icon={Network} label="Connected providers" value={data?.providerCount ?? providerItems.length} foot="Your own provider accounts" tint="#dcebdc" />
      <StatCard icon={Cpu} label="Available models" value={data?.modelCount ?? providerItems.reduce((n, p) => n + p.modelCount, 0)} foot="Across connected providers" tint="#f1e7ce" />
      <StatCard icon={KeyRound} label="Active router keys" value={data?.routerKeyCount ?? 0} foot="Revoke access at any time" tint="#e1e8e4" />
      <StatCard icon={Activity} label="Requests today" value={data?.requestsToday ?? 0} foot="Calls routed through your key" tint="#e9e0d8" />
    </div>
    <div className="dashboard-grid">
      <section className="surface">
        <div className="surface-head"><div><h2 className="surface-title">Recent requests</h2><p className="surface-kicker">Latest activity routed through your endpoint</p></div><Link href="/playground" className="button button-quiet">Open playground <ArrowRight size={13} /></Link></div>
        {recent.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>MODEL</th><th>PROVIDER</th><th>STATUS</th><th>LATENCY</th><th>TIME</th></tr></thead><tbody>{recent.map((request) => <tr key={request.id} data-testid={`row-request-${request.id}`}><td><span className="mono">{request.model}</span></td><td>{request.providerName || '—'}</td><td><span className={`status-badge ${request.status >= 400 ? 'error' : ''}`}>{request.status >= 400 ? `Error ${request.status}` : request.status || 'OK'}</span></td><td>{request.latencyMs} ms</td><td>{formatDate(request.createdAt)}</td></tr>)}</tbody></table></div> : <EmptyState icon={Activity} title="No requests yet" text="Your routed calls will appear here. Try a model in the playground once a provider is connected." action={<Link href="/playground" className="button button-soft">Open playground <ArrowRight size={14} /></Link>} />}
      </section>
      <section className="surface">
        <div className="surface-head"><div><h2 className="surface-title">Connected providers</h2><p className="surface-kicker">Provider connections at a glance</p></div><Link href="/providers" className="button button-quiet">View all <ArrowRight size={13} /></Link></div>
        {providerItems.length ? <div>{providerItems.slice(0, 4).map((provider) => <div key={provider.id} style={{ padding: '14px 20px', borderBottom: '1px solid #f1efe9', display: 'flex', alignItems: 'center', gap: 11 }}><ProviderGlyph kind={provider.kind} /><span style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block', fontSize: 12, color: '#44584b' }}>{provider.name}</strong><small style={{ fontSize: 10, color: '#899187' }}>{provider.modelCount} models · {provider.keyHint}</small></span><span className={`status-badge ${provider.status === 'error' ? 'error' : ''}`}>{provider.status}</span></div>)}</div> : <EmptyState title="No connections yet" text="Providers you connect will show up here." action={<Link href="/providers/new" className="button button-soft"><Plus size={14} /> Add provider</Link>} />}
      </section>
    </div>
  </main>;
}
function StatCard({ icon: Icon, label, value, foot, tint }: { icon: typeof Gauge; label: string; value: number; foot: string; tint: string }) {
  return <article className="stat-card" style={{ '--tint': tint } as CSSProperties}><div className="stat-label"><Icon size={14} />{label}</div><div className="stat-value" data-testid={`stat-${label.toLowerCase().replaceAll(' ', '-')}`}>{value.toLocaleString()}</div><div className="stat-foot">{foot}</div></article>;
}
function ProviderGlyph({ kind }: { kind: string }) {
  const label = ({ nvidia: 'N', openrouter: 'OR', deepseek: 'D', openai: 'O', custom: '↗' } as Record<string, string>)[kind] ?? 'AI';
  return <span className="provider-symbol" style={{ fontSize: 12, fontWeight: 800 }} aria-hidden>{label}</span>;
}

const providerChoices: { kind: ProviderInputKind; name: string; detail: string }[] = [
  { kind: 'nvidia', name: 'NVIDIA NIM', detail: 'NVIDIA-hosted inference endpoints' },
  { kind: 'openrouter', name: 'OpenRouter', detail: 'Models from many upstream providers' },
  { kind: 'deepseek', name: 'DeepSeek', detail: 'DeepSeek API access' },
  { kind: 'openai', name: 'OpenAI', detail: 'OpenAI API access' },
  { kind: 'custom', name: 'Custom OpenAI-compatible', detail: 'Any compatible HTTPS service' },
];

const defaultProviderUrls: Record<ProviderInputKind, string> = {
  nvidia: 'https://integrate.api.nvidia.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  custom: '',
};
const supportedProviderProtocol: ProviderInputApiProtocol = 'openai_chat_completions';

function AddProviderPage() {
  const client = useQueryClient();
  const [, setLocation] = useLocation();
  const createProvider = useCreateProvider();
  const [kind, setKind] = useState<ProviderInputKind>('openrouter');
  const [providerSlug, setProviderSlug] = useState('openrouter');
  const [name, setName] = useState('OpenRouter');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(defaultProviderUrls.openrouter);
  const [showKey, setShowKey] = useState(false);
  const [localError, setLocalError] = useState('');
  const [modelPreview, setModelPreview] = useState<ProviderModelPreview[]>([]);
  const previewModels = usePreviewProviderModels();
  const selected = providerChoices.find((provider) => provider.kind === kind)!;
  const loading = createProvider.isPending || previewModels.isPending;
  function changeKind(nextKind: ProviderInputKind) {
    const nextProvider = providerChoices.find((provider) => provider.kind === nextKind)!;
    setKind(nextKind);
    setProviderSlug(nextKind === 'custom' ? 'custom-api' : nextKind);
    setName(nextProvider.name);
    setBaseUrl(defaultProviderUrls[nextKind]);
    setApiKey('');
    setModelPreview([]);
    setLocalError('');
  }
  function fetchModels() {
    setLocalError('');
    setModelPreview([]);
    const cleanUrl = baseUrl.trim();
    if (!apiKey.trim()) { setLocalError('Enter your provider API key before fetching models.'); return; }
    if (kind === 'custom' && (!cleanUrl || !/^https:\/\//i.test(cleanUrl))) { setLocalError('Custom providers require a public HTTPS base URL.'); return; }
    previewModels.mutate({
      data: {
        kind,
        apiProtocol: supportedProviderProtocol,
        apiKey: apiKey.trim(),
        ...(kind === 'custom' ? { baseUrl: cleanUrl } : {}),
      },
    }, {
      onSuccess: (response) => setModelPreview(response.models),
      onError: (error) => setLocalError(errorMessage(error)),
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    setLocalError('');
    const cleanUrl = baseUrl.trim();
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(providerSlug.trim())) { setLocalError('Use a lowercase provider ID starting with a letter.'); return; }
    if (!name.trim()) { setLocalError('Enter a display name for this provider.'); return; }
    if (!apiKey.trim()) { setLocalError('Enter an API key from your provider account.'); return; }
    if (kind === 'custom' && (!cleanUrl || !/^https:\/\//i.test(cleanUrl))) { setLocalError('Custom providers require a valid HTTPS base URL.'); return; }
    if (!modelPreview.length) { setLocalError('Fetch the available models before connecting this provider.'); return; }
    createProvider.mutate({ data: {
      kind,
      providerSlug: providerSlug.trim(),
      name: name.trim(),
      apiProtocol: supportedProviderProtocol,
      apiKey: apiKey.trim(),
      ...(kind === 'custom' ? { baseUrl: cleanUrl } : {}),
    } }, {
      onSuccess: () => { invalidateProviderData(client); setLocation('/providers'); },
      onError: (error) => setLocalError(errorMessage(error)),
    });
  }
  return <main className="page" data-testid="page-provider-connect">
    <PageHeader eyebrow="Connections / new provider" title="Connect a provider" description="Enter the provider details, fetch its current model catalog, and save the connection securely." action={<Link href="/providers" className="button button-outline"><ArrowRight size={14} style={{ transform: 'rotate(180deg)' }} /> Back to providers</Link>} />
    <section className="surface" style={{ maxWidth: 760, padding: 24, margin: '0 auto' }}>
    <form className="provider-form" onSubmit={submit}>
      <div className="field"><label htmlFor="provider-type">Provider</label><select id="provider-type" value={kind} onChange={(event) => changeKind(event.target.value as ProviderInputKind)} data-testid="select-provider-kind">{providerChoices.map((item) => <option key={item.kind} value={item.kind}>{item.name}</option>)}</select><span className="field-hint">{selected.detail}</span></div>
      <div className="field"><label htmlFor="provider-slug">Provider ID</label><input id="provider-slug" autoComplete="off" maxLength={63} pattern="[a-z][a-z0-9_\\-]{0,62}" placeholder="e.g. openrouter" value={providerSlug} onChange={(event) => { setProviderSlug(event.target.value); setLocalError(''); }} data-testid="input-provider-slug" /><span className="field-hint">Lowercase identifier used in model IDs. Start with a letter; use letters, numbers, underscores, or hyphens.</span></div>
      <div className="field"><label htmlFor="provider-name">Display name</label><input id="provider-name" autoComplete="off" maxLength={80} placeholder={selected.name} value={name} onChange={(event) => setName(event.target.value)} data-testid="input-provider-name" /></div>
      <div className="field"><label htmlFor="provider-url">Base URL</label><input id="provider-url" type="url" readOnly={kind !== 'custom'} placeholder="https://gateway.example/v1" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setModelPreview([]); setLocalError(''); }} data-testid="input-provider-base-url" /><span className="field-hint">{kind === 'custom' ? 'Use a public HTTPS endpoint that supports /models and /chat/completions.' : `Automatically set for ${selected.name}.`}</span></div>
      <div className="field"><label htmlFor="provider-protocol">API protocol</label><select id="provider-protocol" value={supportedProviderProtocol} disabled data-testid="select-provider-protocol"><option value="openai_chat_completions">OpenAI Chat Completions</option></select><span className="field-hint">This is the protocol used by the router for chat requests.</span></div>
      {kind === 'openrouter' && <div className="info-callout"><CircleHelp size={16} /><div><strong>OpenRouter setup</strong><br />Paste the key from <b>OpenRouter → Settings → Keys</b> (usually starts with <span className="mono">sk-or-v1-</span>). The OpenRouter base URL is filled in above.</div></div>}
      <div className="field"><label htmlFor="provider-key">API key</label><div style={{ display: 'flex', gap: 7 }}><input id="provider-key" style={{ flex: 1 }} type={showKey ? 'text' : 'password'} autoComplete="new-password" placeholder="Enter your API key" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setModelPreview([]); setLocalError(''); }} data-testid="input-provider-api-key" /><button className="icon-btn" type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? 'Hide key' : 'Show key'} data-testid="button-toggle-provider-key">{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button></div><span className="field-hint">The key is sent to the server for model discovery, then stored encrypted when you connect.</span></div>
      <div className="field">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}><label>Models</label><button className="button button-quiet" type="button" onClick={fetchModels} disabled={loading || !apiKey.trim() || (kind === 'custom' && !baseUrl.trim())} data-testid="button-fetch-provider-models">{previewModels.isPending ? <><RefreshCw size={13} className="spin" /> Fetching</> : 'Fetch available models'}</button></div>
        {modelPreview.length ? <><span className="field-hint">Found {modelPreview.length} currently available models{modelPreview.length > 100 ? '; showing the first 100.' : '.'}</span><div className="model-list" style={{ maxHeight: 210, overflowY: 'auto' }} data-testid="list-provider-model-preview">{modelPreview.slice(0, 100).map((model) => <span className="model-chip" title={model.modelId} key={model.modelId}>{model.name}</span>)}</div></> : <div className="response-placeholder" style={{ minHeight: 52, height: 'auto', border: '1px dashed #dedfd5', borderRadius: 9, padding: '14px 10px' }}>No models fetched yet. Use the button above to check this connection.</div>}
      </div>
      {(localError || createProvider.isError) && <div className="notice-error" role="alert">{localError || errorMessage(createProvider.error)}</div>}
      <div className="info-callout"><LockKeyhole size={15} /><div><b>Credentials stay protected server-side.</b> The form keeps your API key in memory only; closing it clears the entry.</div></div>
      <div className="modal-actions"><Link href="/providers" className="button button-outline" onClick={(event) => { if (loading) event.preventDefault(); }}>Cancel</Link><button className="button button-primary" disabled={loading || !modelPreview.length} type="submit">{createProvider.isPending ? <><RefreshCw size={14} className="spin" /> Connecting</> : <><Plus size={14} /> Create provider</>}</button></div>
    </form>
    </section>
  </main>;
}

function ProvidersPage() {
  const client = useQueryClient();
  const providersQuery = useListProviders();
  const [expanded, setExpanded] = useState<string | null>(null);
  const refresh = useRefreshProviderModels();
  const remove = useDeleteProvider();
  function deleteItem(provider: Provider) {
    if (!window.confirm(`Remove “${provider.name}” and its discovered models?`)) return;
    remove.mutate({ providerId: provider.id }, { onSuccess: () => invalidateProviderData(client) });
  }
  function refreshItem(id: string) {
    refresh.mutate({ providerId: id }, { onSuccess: () => invalidateProviderData(client) });
  }
  const providers = providersQuery.data ?? [];
  return <main className="page">
    <PageHeader eyebrow="Connections / catalog" title="Providers & models" description="Connect accounts, refresh model availability, and keep every upstream credential behind the router. Catalogs are checked at least once a minute; models rejected by a provider are hidden for 24 hours." action={<Link href="/providers/new" className="button button-primary" data-testid="button-add-provider"><Plus size={15} /> Add provider</Link>} />
    <div className="info-callout" style={{ marginBottom: 18 }}><ShieldCheck size={17} /><div>Provider API keys come from your own provider accounts and are sent to the router server only. The browser receives a masked hint, never the credential itself.</div></div>
    {refresh.isError && <div className="notice-error" role="alert">{errorMessage(refresh.error)}</div>}{remove.isError && <div className="notice-error" role="alert">{errorMessage(remove.error)}</div>}
    {providersQuery.isLoading || providersQuery.isFetching ? <LoadingBlock label="Checking current provider catalogs" /> : providersQuery.isError ? <QueryError retry={() => { void providersQuery.refetch(); }} /> : providers.length ? <div className="provider-grid">{providers.map((provider) => {
      const isExpanded = expanded === provider.id;
      const models = provider.models ?? [];
      return <article className="surface provider-card" key={provider.id} data-testid={`card-provider-${provider.id}`}>
        <div className="provider-top"><ProviderGlyph kind={provider.kind} /><div style={{ minWidth: 0 }}><h2 className="provider-title">{provider.name}</h2><div className="provider-meta">{provider.providerSlug} · {provider.kind === 'custom' ? provider.baseUrl : provider.baseUrl} · {provider.keyHint}</div></div><div className="provider-spacer" /><span className={`status-badge ${provider.status === 'error' ? 'error' : ''}`} data-testid={`status-provider-${provider.id}`}>{provider.status}</span></div>
        <div className="provider-details"><span><b>{provider.modelCount}</b> {provider.modelCount === 1 ? 'model' : 'models'}</span><span>Last checked {formatDate(provider.lastSyncedAt)}</span></div>
        {isExpanded && <div className="model-list" data-testid={`list-models-${provider.id}`}>{models.length ? models.map((model) => <span key={model.id} className="model-chip" title={model.modelId}>{model.name || model.modelId}{model.contextLength ? ` · ${model.contextLength.toLocaleString()}` : ''}</span>) : <span className="field-hint">{provider.status === 'error' ? 'The provider catalog could not be refreshed. Its last-known model IDs are hidden until a successful check.' : 'The provider currently reports no available models.'}</span>}</div>}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 14 }}>
          <button className="button button-quiet" onClick={() => setExpanded(isExpanded ? null : provider.id)} data-testid={`button-models-${provider.id}`}><Cpu size={14} /> {isExpanded ? 'Hide models' : 'Inspect models'} <ChevronDown size={13} style={{ transform: isExpanded ? 'rotate(180deg)' : undefined }} /></button>
          <div className="provider-actions"><button className="icon-btn" aria-label={`Refresh ${provider.name} models`} title="Refresh models" disabled={refresh.isPending} onClick={() => refreshItem(provider.id)} data-testid={`button-refresh-${provider.id}`}><RefreshCw size={15} className={refresh.isPending ? 'spin' : ''} /></button><button className="icon-btn" aria-label={`Remove ${provider.name}`} title="Remove provider" disabled={remove.isPending} onClick={() => deleteItem(provider)} data-testid={`button-remove-${provider.id}`}><Trash2 size={15} /></button></div>
        </div>
      </article>;
    })}</div> : <section className="surface"><EmptyState icon={Network} title="Connect your first provider" text="Add an account to discover its available models. Your provider key stays protected on the server." action={<Link href="/providers/new" className="button button-primary"><Plus size={14} /> Add provider</Link>} /></section>}
  </main>;
}

function KeysPage() {
  const client = useQueryClient();
  const keysQuery = useListRouterKeys();
  const create = useCreateRouterKey();
  const revoke = useRevokeRouterKey();
  const [createOpen, setCreateOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [baseUrlCopied, setBaseUrlCopied] = useState(false);
  const keys = keysQuery.data ?? [];
  const toolBaseUrl = `${window.location.origin}/api/v1`;
  function createKey(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!keyName.trim()) { setError('Name this key so you can recognize its purpose later.'); return; }
    create.mutate({ data: { name: keyName.trim() } }, { onSuccess: (result) => { setCreatedSecret(result.key); setCreatedName(result.name); setCreateOpen(false); setKeyName(''); void client.invalidateQueries({ queryKey: getListRouterKeysQueryKey() }); void client.invalidateQueries({ queryKey: getGetRouterDashboardQueryKey() }); }, onError: (e) => setError(errorMessage(e)) });
  }
  function revokeKey(key: RouterKey) {
    if (!window.confirm(`Revoke the router key “${key.name}”? Applications using it will no longer be able to make requests.`)) return;
    revoke.mutate({ keyId: key.id }, { onSuccess: () => { void client.invalidateQueries({ queryKey: getListRouterKeysQueryKey() }); void client.invalidateQueries({ queryKey: getGetRouterDashboardQueryKey() }); }, onError: (e) => setError(errorMessage(e)) });
  }
  async function copySecret() {
    if (!createdSecret) return;
    try { await navigator.clipboard.writeText(createdSecret); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }
    catch { setError('Clipboard access was unavailable. Select and copy the key manually.'); }
  }
  async function copyToolBaseUrl() {
    try { await navigator.clipboard.writeText(toolBaseUrl); setBaseUrlCopied(true); window.setTimeout(() => setBaseUrlCopied(false), 1800); }
    catch { setError('Clipboard access was unavailable. Copy the tool base URL manually.'); }
  }
  return <main className="page">
    <PageHeader eyebrow="Access / credentials" title="Router keys" description="Create a key for your applications. The full value is shown once, then only its prefix remains visible." action={<button className="button button-primary" onClick={() => { setCreateOpen(true); setError(''); }} data-testid="button-create-router-key"><Plus size={15} /> Create router key</button>} />
    <div className="setup-banner"><div><h2>One key for every connected provider.</h2><p>Your app sends this router key to the OpenAI-compatible endpoint. Upstream provider credentials remain on the server.</p></div><div className="mono" style={{ color: '#c9e4c2', position: 'relative', zIndex: 1 }}>Authorization: Bearer &lt;router-key&gt;</div></div>
    <section className="surface" style={{ marginBottom: 18, padding: 18 }} data-testid="tool-model-connection">
      <div className="surface-head" style={{ padding: 0, borderBottom: 0, marginBottom: 12 }}>
        <div><h2 className="surface-title">Use every model in your tools</h2><p className="surface-kicker">OpenAI-compatible connection for IDEs and coding clients</p></div>
        <button className="button button-outline" onClick={() => void copyToolBaseUrl()} data-testid="button-copy-tool-base-url">{baseUrlCopied ? <Check size={14} /> : <Copy size={14} />}{baseUrlCopied ? 'Copied' : 'Copy base URL'}</button>
      </div>
      <div className="key-value" style={{ marginBottom: 12 }}><span data-testid="text-tool-base-url">{toolBaseUrl}</span></div>
      <p className="field-hint" style={{ margin: '0 0 10px' }}>Set this as your tool’s OpenAI-compatible Base URL, and use a router key as its API key. Compatible tools will fetch the live model list from <span className="mono">GET /models</span>.</p>
      <div className="info-callout"><Code2 size={15} /><div><b>OpenCode and Chat Completions agents</b><br />Choose an OpenAI-compatible provider, use this Base URL and a router key, then select the model ID returned by <span className="mono">GET /models</span>. Tool calls, tool results, streaming, and provider-specific fields are forwarded; long streams receive keep-alives and stay open until the provider finishes.</div></div>
      <div className="info-callout" style={{ marginTop: 10 }}><Cpu size={15} /><div><b>Codex and Responses API clients</b><br />Use <span className="mono">POST /responses</span> at the same Base URL. This is forwarded to the connected provider; it works only when that provider supports the Responses API. Chat Completions-only providers should be used with OpenCode instead.</div></div>
    </section>
    {error && !createOpen && <div className="notice-error" role="alert">{error}</div>}
    {keysQuery.isLoading ? <LoadingBlock label="Loading router keys" /> : keysQuery.isError ? <QueryError retry={() => { void keysQuery.refetch(); }} /> : keys.length ? <section className="surface">
      <div className="surface-head"><div><h2 className="surface-title">Active keys</h2><p className="surface-kicker">Manage access to your private router</p></div><span className="status-badge">{keys.length} active</span></div>
      <div className="table-wrap"><table className="data-table"><thead><tr><th>NAME</th><th>KEY PREFIX</th><th>CREATED</th><th>LAST USED</th><th></th></tr></thead><tbody>{keys.map((key) => <tr key={key.id} data-testid={`row-key-${key.id}`}><td><strong style={{ color: '#40564a' }}>{key.name}</strong></td><td><span className="mono">{key.prefix}••••••••</span></td><td>{formatDate(key.createdAt)}</td><td>{formatDate(key.lastUsedAt)}</td><td><button className="button button-danger" disabled={revoke.isPending} onClick={() => revokeKey(key)} data-testid={`button-revoke-${key.id}`}><Trash2 size={13} /> Revoke</button></td></tr>)}</tbody></table></div>
    </section> : <section className="surface"><EmptyState icon={KeyRound} title="No router keys yet" text="Create a key for your app. It will be visible only once, so store it somewhere secure." action={<button className="button button-primary" onClick={() => setCreateOpen(true)}><Plus size={14} /> Create router key</button>} /></section>}
    {createOpen && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-key-title"><header className="modal-header"><div><div className="eyebrow">New access key</div><h2 id="create-key-title">Create router key</h2><p>Give your key a name that describes where it will be used.</p></div><button className="icon-btn" aria-label="Close" onClick={() => setCreateOpen(false)}><X size={18} /></button></header><form onSubmit={createKey}><div className="field"><label htmlFor="router-key-name">Key name</label><input id="router-key-name" autoFocus value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="e.g. local development" maxLength={80} data-testid="input-router-key-name" /></div>{error && <div className="notice-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button button-outline" type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="button button-primary" disabled={create.isPending} type="submit">{create.isPending ? 'Creating…' : 'Create key'}</button></div></form></section></div>}
    {createdSecret && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="created-key-title"><header className="modal-header"><div><div className="eyebrow">Key created</div><h2 id="created-key-title">Copy it now, {createdName}.</h2><p>This is the only time the full key will be shown. Store it in a secrets manager before closing.</p></div><button className="icon-btn" aria-label="Close" onClick={() => setCreatedSecret(null)}><X size={18} /></button></header><div className="info-callout callout-amber"><AlertCircle size={16} /><span>Leaving this dialog hides the key permanently. If you lose it, revoke it and create a replacement.</span></div><div className="key-value" style={{ marginTop: 14 }} data-testid="text-created-router-key"><span>{createdSecret}</span></div>{error && <div className="notice-error">{error}</div>}<div className="modal-actions"><button className="button button-outline" onClick={() => setCreatedSecret(null)}>Done</button><button className="button button-primary" onClick={copySecret} data-testid="button-copy-router-key">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy key'}</button></div></section></div>}
  </main>;
}

function PlaygroundPage() {
  const client = useQueryClient();
  const providers = useListProviders();
  const models = useMemo(() => providers.isFetching || providers.isError ? [] : (providers.data ?? []).filter((provider) => provider.status === 'connected').flatMap((provider) => (provider.models ?? []).map((model) => ({ value: `${provider.providerSlug}/${model.modelId}`, name: model.name || model.modelId, provider: provider.name }))), [providers.data, providers.isError, providers.isFetching]);
  const [model, setModel] = useState('');
  const [routerKey, setRouterKey] = useState('');
  const [prompt, setPrompt] = useState('Explain how a single API router can make switching model providers easier.');
  const [resultMode, setResultMode] = useState<'quick' | 'openai'>('quick');
  const [quickResult, setQuickResult] = useState<{ response: string; latencyMs: number; providerName: string; model: string } | null>(null);
  const [chatResult, setChatResult] = useState<unknown>(null);
  const [requestError, setRequestError] = useState('');
  const quickTest = useTestRouterCompletion();
  const chatCompletion = useCreateChatCompletion({
    request: { headers: routerKey ? { Authorization: `Bearer ${routerKey}` } : {} },
  });
  const chosenModel = model || models[0]?.value || '';
  useEffect(() => {
    if (!model && models.length) setModel(models[0].value);
  }, [model, models]);
  function runQuick(event: FormEvent) {
    event.preventDefault();
    if (!chosenModel || !prompt.trim()) return;
    setRequestError(''); setQuickResult(null); setChatResult(null);
    quickTest.mutate({ data: { model: chosenModel, prompt: prompt.trim() } }, { onSuccess: (result) => { setQuickResult(result); setResultMode('quick'); void client.invalidateQueries({ queryKey: getListRouterRequestsQueryKey({ limit: 8 }) }); void client.invalidateQueries({ queryKey: getGetRouterDashboardQueryKey() }); }, onError: (error) => { setRequestError(errorMessage(error)); void client.invalidateQueries({ queryKey: getListProvidersQueryKey() }); } });
  }
  function runOpenAI(event: FormEvent) {
    event.preventDefault();
    if (!chosenModel || !prompt.trim()) return;
    if (!routerKey.trim()) {
      setRequestError('Paste a router key to send this OpenAI-compatible request.');
      return;
    }
    setRequestError(''); setQuickResult(null); setChatResult(null);
    chatCompletion.mutate({ data: { model: chosenModel, messages: [{ role: 'user', content: prompt.trim() }] } }, { onSuccess: (result) => { setChatResult(result); setResultMode('openai'); void client.invalidateQueries({ queryKey: getListRouterRequestsQueryKey({ limit: 8 }) }); void client.invalidateQueries({ queryKey: getGetRouterDashboardQueryKey() }); }, onError: (error) => { setRequestError(errorMessage(error)); void client.invalidateQueries({ queryKey: getListProvidersQueryKey() }); } });
  }
  const busy = quickTest.isPending || chatCompletion.isPending;
  const requestPayload = JSON.stringify({ model: chosenModel || '<model-id>', messages: [{ role: 'user', content: prompt }], stream: false }, null, 2);
  const shownResult = resultMode === 'quick' && quickResult ? quickResult.response : chatResult ? JSON.stringify(chatResult, null, 2) : '';
  return <main className="page">
    <PageHeader eyebrow="Test / inspect" title="Playground" description="Send a quick prompt to a connected model, or inspect the standard OpenAI-compatible request shape." />
    {providers.isError ? <QueryError retry={() => { void providers.refetch(); }} message="Could not check the providers’ current model lists." /> : providers.isLoading || providers.isFetching ? <LoadingBlock label="Checking current model availability" /> : !models.length ? <section className="surface"><EmptyState icon={Cpu} title="No currently available models" text="Connect a provider or check its connection. Model choices are shown only after the provider confirms them." action={<Link href="/providers/new" className="button button-primary"><Plus size={14} /> Connect a provider</Link>} /></section> : <div className="playground-layout">
      <section className="surface playground-pane"><div className="pane-title">Run a test</div><form onSubmit={runQuick}>
        <div className="field"><label htmlFor="playground-model">Model</label><select id="playground-model" value={chosenModel} onChange={(event) => setModel(event.target.value)} data-testid="select-playground-model">{models.map((item, index) => <option value={item.value} key={`${item.value}-${index}`}>{item.name} · {item.provider}</option>)}</select></div>
        <div className="field" style={{ marginTop: 14 }}><label htmlFor="playground-prompt">Prompt</label><textarea id="playground-prompt" rows={7} maxLength={2000} value={prompt} onChange={(event) => setPrompt(event.target.value)} data-testid="input-playground-prompt" /><span className="field-hint">{prompt.length} / 2,000 characters</span></div>
        <div className="field" style={{ marginTop: 14 }}><label htmlFor="playground-router-key">Router key for OpenAI test</label><input id="playground-router-key" type="password" autoComplete="off" value={routerKey} onChange={(event) => setRouterKey(event.target.value)} placeholder="Paste a router key from the Keys page" data-testid="input-playground-router-key" /><span className="field-hint">Held only in this page's memory. The quick test does not require a router key.</span></div>
        {requestError && <div className="notice-error" role="alert">{requestError}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}><button className="button button-primary" disabled={busy || !prompt.trim()} type="submit" data-testid="button-run-test">{quickTest.isPending ? <><RefreshCw size={14} className="spin" /> Sending</> : <><Sparkles size={14} /> Quick test</>}</button><button className="button button-outline" disabled={busy || !prompt.trim() || !routerKey.trim()} type="button" onClick={runOpenAI} data-testid="button-openai-completion">{chatCompletion.isPending ? 'Sending…' : <><Code2 size={14} /> Send OpenAI request</>}</button></div>
        <p className="field-hint" style={{ marginTop: 12 }}>The quick test uses your connected provider. The OpenAI-compatible request authenticates with your router key. Provider keys are never sent from this browser.</p>
      </form></section>
      <div style={{ display: 'grid', gap: 15 }}>
        <section className="surface playground-pane"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}><div className="pane-title" style={{ margin: 0 }}>Response</div>{quickResult && resultMode === 'quick' && <span className="status-badge"><Clock3 size={11} /> {quickResult.latencyMs} ms</span>}</div>
          {busy ? <div className="response-placeholder"><div><RefreshCw size={18} className="spin" style={{ marginBottom: 8 }} /><br />Waiting for your model…</div></div> : shownResult ? <><div className="field-hint" style={{ marginBottom: 9 }}>{resultMode === 'quick' ? `${quickResult?.providerName} · ${quickResult?.model}` : 'OpenAI-compatible response body'}</div><div className="response-box" data-testid="text-playground-response">{shownResult}</div></> : <div className="response-placeholder"><div><MessageSquareText size={22} style={{ marginBottom: 9 }} /><br />Model output will appear here.</div></div>}
        </section>
        <section className="surface playground-pane"><div className="pane-title">OpenAI-compatible request</div><div className="info-callout" style={{ marginBottom: 12 }}><Code2 size={15} /><div><b>POST /api/v1/chat/completions</b><br />Use the model ID shown above and authenticate with a router key from the Keys page.</div></div><pre className="code-block" data-testid="text-request-payload">{requestPayload}</pre></section>
      </div>
    </div>}
  </main>;
}

function LoadingConfig() {
  return <div className="min-h-screen flex items-center justify-center bg-[#fbfaf4] text-sm text-[#526156]">Loading…</div>;
}

function App() {
  const config = useRuntimeConfig();
  const ready = config !== null && (config.authDisabled === true || Boolean(config.supabaseUrl && config.supabasePublishableKey));
  return <QueryClientProvider client={queryClient}><WouterRouter base={basePath}>{config === null ? <LoadingConfig /> : ready ? <AuthProvider config={config as RuntimeConfig}><AppRoutes /></AuthProvider> : <MissingAuthConfig />}</WouterRouter></QueryClientProvider>;
}

export default App;
