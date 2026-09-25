import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { usePatchSettings } from '../settings/api/settings-query';
import { useSiteBranding } from './site-branding';

export function BrandingSettings({ disabled }: { disabled: boolean }) {
  const branding = useSiteBranding();
  const patch = usePatchSettings();
  const [name, setName] = useState(branding.name);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  useEffect(() => setName(branding.name), [branding.name]);
  const save = async (values: Record<string, string>) => {
    setError('');
    try { await patch.mutateAsync(values); } catch { setError(t("设置保存或读取失败，请重试。")); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 512 * 1024) { setError(t("请选择不超过 512 KB 的 PNG、JPEG 或 WebP 图片")); return; }
    setReading(true);
    try {
      const value = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      await save({ 'branding.logo': value });
    } catch { setError(t("Logo 读取失败")); } finally { setReading(false); }
  };
  const busy = disabled || reading || patch.isPending;
  return <section className="branding-settings" aria-label={t("网站外观")}>
    <h2>{t("网站外观")}</h2><p className="muted-label">{t("网站名称和 Logo 对所有账号及登录页生效。")}</p>
    <form onSubmit={event => { event.preventDefault(); void save({ 'branding.name': name.trim() }); }}><label><span>{t("网站名称")}</span><input aria-label={t("网站名称")} value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} /></label><button className="quiet-command" disabled={busy || !name.trim() || name.trim() === branding.name}>{t("保存名称")}</button></form>
    <div className="branding-logo-control"><img src={branding.logoUrl} alt={t("网站 Logo")} width={48} height={48} /><label className="quiet-command">{t("上传 Logo")}<input aria-label={t("上传 Logo")} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void upload(file); }} /></label><button className="quiet-command" disabled={busy} onClick={() => void save({ 'branding.logo': '' })}>{t("恢复默认 Logo")}</button></div>
    {error && <p role="alert" className="error-state">{error}</p>}
  </section>;
}
