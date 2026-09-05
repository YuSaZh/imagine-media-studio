import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Save } from 'lucide-react';
import { internalClient } from '../../api/internal-client';
import { usePatchSettings, useSettingsQuery } from '../settings/api/settings-query';

export function useAccount() { return useQuery({ queryKey: ['internal', 'account'], queryFn: () => internalClient.getMyAccount() }); }

export function AccountSettings({ online }: { online: boolean }) {
  const account = useAccount();
  const settings = useSettingsQuery();
  const patch = usePatchSettings();
  const user = account.data?.user;
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => { setUrl(String(settings.data?.settings.public_base_url ?? '')); }, [settings.data?.settings.public_base_url]);
  useEffect(() => { setUsername(user?.username ?? ''); }, [user?.username]);
  const save = async (action: () => Promise<unknown>) => {
    setBusy(true); setMessage(''); setFailed(false);
    try { await action(); setMessage('已保存'); }
    catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  };
  if (!user) return null;
  return <>
    {user.role === 'admin' && <form onSubmit={event => { event.preventDefault(); void save(() => patch.mutateAsync({ public_base_url: url.trim() })); }}>
      <label className="setting-line"><span>公网域名</span><input aria-label="公网域名" type="url" placeholder="https://imagine.example.com" value={url} disabled={!online || busy} onChange={event => setUrl(event.target.value)} /></label>
      <button className="quiet-command" disabled={!online || busy} type="submit"><Save size={16} />保存公网域名</button>
    </form>}
    <form className="account-form" onSubmit={event => { event.preventDefault(); void save(async () => { await internalClient.updateMyAccount({ currentPassword, username, ...(password ? { password } : {}) }); setCurrentPassword(''); setPassword(''); await account.refetch(); }); }}>
      <h2>我的账号</h2>
      <label className="setting-line"><span>用户名</span><input aria-label="账号用户名" required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label className="setting-line"><span>当前密码</span><input aria-label="当前密码" required type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>
      <label className="setting-line"><span>新密码</span><input aria-label="新密码" type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button className="quiet-command" type="submit" disabled={!online || busy}><Save size={16} />保存账号</button>
    </form>
    {message && <p className={failed ? 'error-state' : 'success-state'} role={failed ? 'alert' : 'status'}>{message}</p>}
    {user.role === 'admin' && <AccountManagement online={online} />}
  </>;
}

function AccountManagement({ online }: { online: boolean }) {
  const query = useQuery({ queryKey: ['internal', 'accounts'], queryFn: internalClient.listAccounts, enabled: online });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingEnabled, setPendingEnabled] = useState<Record<string, boolean>>({});
  const action = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await operation(); await query.refetch(); } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); } finally { setBusy(false); }
  };
  const toggle = (id: string, enabled: boolean) => {
    setPendingEnabled(current => ({ ...current, [id]: enabled }));
    void action(() => internalClient.updateAccount(id, { enabled })).finally(() => setPendingEnabled(current => { const next = { ...current }; delete next[id]; return next; }));
  };
  return <section className="account-form"><h2>账号管理</h2>
    {query.data?.users.map(user => <label className="setting-line" key={user.id}><span>{user.username}{user.role === 'admin' ? ' · 管理员' : ''}</span><input aria-label={`启用账号 ${user.username}`} type="checkbox" checked={pendingEnabled[user.id] ?? user.enabled} disabled={!online || busy || user.role === 'admin'} onChange={event => toggle(user.id, event.target.checked)} /></label>)}
    <form onSubmit={event => { event.preventDefault(); void action(async () => { await internalClient.createAccount(username, password); setUsername(''); setPassword(''); }); }}>
      <label className="setting-line"><span>新账号</span><input aria-label="新账号用户名" required autoComplete="off" maxLength={64} value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label className="setting-line"><span>初始密码</span><input aria-label="新账号初始密码" required type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button className="quiet-command" type="submit" disabled={!online || busy}><Plus size={16} />添加账号</button>
    </form>{(error || query.isError) && <p role="alert" className="error-state">{error || '账号加载失败'}</p>}
  </section>;
}
