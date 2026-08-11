import { create } from "zustand";
import type { ReactNode } from "react";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
  /** When true, render a thin separator instead of a button. */
  separator?: boolean;
  /** When true, render a non-clickable group label (organizes a submenu). */
  header?: boolean;
  /** Nested items shown as a flyout when this item is hovered. */
  submenu?: MenuItem[];
}

interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  items: MenuItem[];
  /** Open (or reposition) the menu at the given client coordinates. */
  show: (x: number, y: number, items: MenuItem[]) => void;
  close: () => void;
}

export const useContextMenu = create<ContextMenuState>((set) => ({
  open: false,
  x: 0,
  y: 0,
  items: [],
  show: (x, y, items) => set({ open: true, x, y, items }),
  close: () => set({ open: false }),
}));
