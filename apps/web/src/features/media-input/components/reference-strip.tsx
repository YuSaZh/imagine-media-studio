import type { AssetInput } from '@imagine/shared';
import { AlertCircle, LoaderCircle, RotateCcw, X } from 'lucide-react';

import { IconButton } from '../../../components/icon-button.js';
import type { UploadStatus } from '../model/types.js';

export interface ReferenceStripItem {
  alt: string;
  error: string | null;
  id: string;
  incompatible: boolean;
  role: AssetInput['role'];
  src: string;
  status: UploadStatus | 'checking' | 'missing' | 'stored';
}

function roleLabel(role: AssetInput['role']): string | null {
  if (role === 'source') return 'Source';
  if (role === 'first_frame') return 'First frame';
  if (role === 'last_frame') return 'Last frame';
  if (role === 'mask') return 'Mask';
  return null;
}

function statusLabel(item: ReferenceStripItem): string | null {
  if (item.status === 'checking') return 'Checking input';
  if (item.status === 'missing') return 'Input is no longer available';
  if (item.incompatible) return 'Not supported by this model';
  if (item.status === 'queued') return 'Queued';
  if (item.status === 'preprocessing') return 'Preparing';
  if (item.status === 'uploading') return 'Uploading';
  if (item.status === 'error') return item.error ?? 'Upload failed';
  return null;
}

export function ReferenceStrip({
  items,
  onRemove,
  onRetry,
}: {
  items: readonly ReferenceStripItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="reference-strip" aria-label="Generation inputs">
      {items.map((item) => {
        const status = statusLabel(item);
        const role = roleLabel(item.role);
        return (
          <div
            className={`reference-preview ${item.incompatible ? 'is-incompatible' : ''} ${item.status === 'error' ? 'has-error' : ''}`}
            key={item.id}
          >
            <img alt={item.alt} src={item.src} />
            {role && <span className="reference-role">{role}</span>}
            {status && (
              <span className="reference-upload-state">
                {item.status === 'error' || item.incompatible
                  ? <AlertCircle aria-hidden="true" size={12} />
                  : <LoaderCircle aria-hidden="true" className={item.incompatible ? '' : 'is-spinning'} size={12} />}
                <span>{status}</span>
              </span>
            )}
            {item.status === 'error' && (
              <IconButton
                className="reference-retry"
                icon={<RotateCcw size={13} />}
                label={`Retry ${item.alt}`}
                onClick={() => onRetry(item.id)}
              />
            )}
            <IconButton
              icon={<X size={13} />}
              label={`Remove ${item.alt}`}
              onClick={() => onRemove(item.id)}
            />
          </div>
        );
      })}
    </div>
  );
}
