import { SquareDashed } from 'lucide-react';
import { Choice, Options } from './ui';

export function AspectRatioChoices({ options, value, onChange }: { options: string[]; value: string; onChange: (value: string) => void }) {
  const columns = Math.max(1, Math.ceil(options.length / Math.max(1, Math.ceil(options.length / 6))));
  return <div className="ratio-options" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, width: `${Math.max(200, columns * 50)}px` }}>{options.map(option => <Choice key={option} active={value === option} onClick={() => onChange(option)}>
    {option === 'auto' ? <SquareDashed className="ratio-auto" size={24} strokeWidth={1.5} aria-hidden="true" /> : <i style={{ aspectRatio: option.replace(':', '/') }} />}
    <span>{option}</span>
  </Choice>)}</div>;
}

export function AspectRatioSetting({ options, value, onChange, disabled = false, label = '画幅' }: { options: string[]; value: string; onChange: (value: string) => void; disabled?: boolean; label?: string }) {
  return <div className="setting-line"><span>{label}</span><Options label={label} disabled={disabled} trigger={<span>{value}</span>}>
    <div className="option-heading">{label}</div><AspectRatioChoices options={options} value={value} onChange={onChange} />
  </Options></div>;
}
