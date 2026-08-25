import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Menu, X } from 'lucide-react';
import { NavLink } from 'react-router-dom';

export interface MobileNavigationItem {
  icon: ReactNode;
  label: string;
  to: string;
}

interface MobileMenuProps {
  isOnline: boolean;
  items: readonly MobileNavigationItem[];
}

export function MobileMenu({ isOnline, items }: MobileMenuProps) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button className="mobile-menu-trigger" type="button">
          <Menu aria-hidden="true" size={20} />
          <span className="sr-only">Open navigation</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="mobile-menu-overlay" />
        <Dialog.Content className="mobile-menu-content">
          <header className="mobile-menu-heading">
            <div>
              <Dialog.Title>Navigate</Dialog.Title>
              <Dialog.Description>
                Move between the media workspace and local settings.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button className="mobile-menu-close" type="button">
                <X aria-hidden="true" size={20} />
                <span className="sr-only">Close navigation</span>
              </button>
            </Dialog.Close>
          </header>

          <nav aria-label="Mobile navigation" className="mobile-menu-navigation">
            {items.map((item) => (
              <Dialog.Close asChild key={item.to}>
                <NavLink className="mobile-menu-link" to={item.to}>
                  <span className="mobile-menu-link-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span>{item.label}</span>
                </NavLink>
              </Dialog.Close>
            ))}
          </nav>

          <p className={`mobile-menu-network ${isOnline ? 'is-online' : 'is-offline'}`} role="status">
            <span aria-hidden="true" />
            {isOnline ? 'Online' : 'Offline'}
          </p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
