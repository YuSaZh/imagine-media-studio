import type { ButtonHTMLAttributes, ReactNode } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
  label: string;
  tone?: 'default' | 'primary' | 'danger';
}

export function IconButton({
  className = '',
  icon,
  label,
  tone = 'default',
  type = 'button',
  ...props
}: IconButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button
          {...props}
          aria-label={label}
          className={`icon-button icon-button--${tone} ${className}`.trim()}
          type={type}
        >
          {icon}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
